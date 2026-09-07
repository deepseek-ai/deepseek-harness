/** Host-side controller for the isolated Client test fixture. */

import { Worker } from 'node:worker_threads'
import type { InspectorClientBootstrap } from '../../src/shared/bridge/messages/control.ts'
import type { CordisRuntimeTree } from '../../src/shared/cordis/model.ts'
import type { InspectorJsonValue } from '../../src/shared/json.ts'

/** Optional source artifact exposed by the Client fixture. */
interface ClientFixtureSourceCatalog {
  readonly sourceText: string
  readonly sourceMap: string
  readonly sourceUrl: string
  readonly sourceMapUrl: string
}

/** Options for one isolated Client fixture. */
export interface ClientFixtureOptions {
  readonly label?: string
  readonly sourceCatalog?: ClientFixtureSourceCatalog
}

interface FixtureResponse {
  readonly type: 'response'
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

/** A Client producer running outside the Host test realm. */
export class InspectorClientFixture {
  private readonly worker: Worker
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>()
  private nextId = 0
  private closed = false
  readonly fiberUid: number

  private constructor(worker: Worker, fiberUid: number) {
    this.worker = worker
    this.fiberUid = fiberUid
    worker.on('message', (message: unknown) => { this.receive(message) })
    worker.on('error', (error) => { this.fail(error) })
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this.fail(new Error(`Inspector Client fixture exited with code ${String(code)}`))
    })
  }

  /** Start one Client fixture and wait for its Cordis tree to be published. */
  static async start(
    bootstrap: InspectorClientBootstrap,
    options: ClientFixtureOptions = {},
  ): Promise<InspectorClientFixture> {
    const ready = Promise.withResolvers<number>()
    const entry = new URL('./client-source.client.ts', import.meta.url)
    const tsxApi = import.meta.resolve('tsx/esm/api')
    const source = `import { register } from ${JSON.stringify(tsxApi)}\nregister()\nawait import(${JSON.stringify(entry.href)})`
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      execArgv: [],
      workerData: {
        bootstrap,
        label: options.label ?? 'Test Client',
        ...(options.sourceCatalog === undefined ? {} : { sourceCatalog: options.sourceCatalog }),
      },
    })
    const onMessage = (message: unknown): void => {
      if (!isRecord(message) || message.type !== 'ready' || typeof message.fiberUid !== 'number') return
      ready.resolve(message.fiberUid)
    }
    worker.on('message', onMessage)
    worker.once('error', ready.reject)
    const fiberUid = await ready.promise
    worker.off('message', onMessage)
    return new InspectorClientFixture(worker, fiberUid)
  }

  /** Publish one observation from the Client realm. */
  async publish(topic: string, value: InspectorJsonValue): Promise<void> {
    await this.request({ op: 'publish', topic, value })
  }

  /** Set one JSON-compatible global used by Client Runtime evaluation. */
  async setGlobal(name: string, value: InspectorJsonValue): Promise<void> {
    await this.request({ op: 'set-global', name, value })
  }

  /** Emit one Console event carrying a caller-provided value. */
  async log(value: InspectorJsonValue, marker: string): Promise<void> {
    await this.request({ op: 'log-value', value, marker })
  }

  /** Emit one Console event carrying the fixture's Context and Fiber. */
  async logCordis(marker: string): Promise<void> {
    await this.request({ op: 'log-cordis', marker })
  }

  /** Read the consumer-neutral Cordis tree through the Client service. */
  async getCordisTree(): Promise<CordisRuntimeTree> {
    return await this.request({ op: 'get-tree' }) as CordisRuntimeTree
  }

  /**
   * Pause or resume ingest reads without blocking the fixture MessagePort.
   * @param paused - Whether incoming WebSocket frames must wait.
   */
  async setIngestPaused(paused: boolean): Promise<void> {
    await this.request({ op: 'set-ingest-paused', paused })
  }

  /** Break the active ingest socket while preserving the Client source. */
  async disconnect(): Promise<void> {
    await this.request({ op: 'disconnect' })
  }

  /** Trigger a Cordis observation without changing the runtime tree. */
  async refreshTree(): Promise<void> {
    await this.request({ op: 'refresh-tree' })
  }

  /** Add one Fiber to the inspected Client runtime. */
  async addFiber(): Promise<number> {
    return await this.request({ op: 'add-fiber' }) as number
  }

  /** Remove the Fiber most recently added by {@link addFiber}. */
  async removeFiber(): Promise<void> {
    await this.request({ op: 'remove-fiber' })
  }

  /** Dispose the Client source and its Cordis context. */
  async close(): Promise<void> {
    if (this.closed) return
    await this.request({ op: 'close' })
    this.closed = true
    await this.worker.terminate()
  }

  private async request(fields: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Inspector Client fixture is closed')
    const id = ++this.nextId
    const result = Promise.withResolvers<unknown>()
    this.pending.set(id, result)
    this.worker.postMessage({ id, ...fields })
    return await result.promise
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || message.type !== 'response' || typeof message.id !== 'number') return
    const response = message as unknown as FixtureResponse
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.value)
    else pending.reject(new Error(response.error ?? 'Inspector Client fixture request failed'))
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
