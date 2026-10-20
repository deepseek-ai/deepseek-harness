/**
 * MCP server manager (`ctx.mcpServers`): one fleet of `dsh-mcp-client`
 * instances that plugins register for their own lifetime through
 * `register()`. Every registration change reconciles the live instance set: a
 * new registration mounts and a removed one unmounts. Connection handling
 * stays entirely in mcp-client; the manager owns instance lifecycle, the
 * aggregated status registry, and the `restart` and `watch` operations a
 * management surface calls through Remote.
 *
 * Service package (default-exports the service class). All child instances
 * mount under the manager's fiber, so disposing the manager unwinds every
 * instance and its registered tools.
 *
 * @module @deepseek-ai/dsh-mcp-manager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { connectionStatusOf } from '@deepseek-ai/dsh-mcp-client'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { McpCloseResult } from '@deepseek-ai/dsh-mcp-client'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { McpManagedServerStatus, McpManagedServerView } from './types.ts'
// Side-effect type import: declares the tool service.
import type {} from '@deepseek-ai/dsh-tools'

export type { McpManagedServerStatus, McpManagedServerView } from './types.ts'

/** One Streamable HTTP MCP server a plugin contributes for its own lifetime. */
export interface McpServerRegistration {
  /** MCP endpoint URL. */
  url: string
}

/** Manager configuration. */
export interface Config {
  /** Budget for each server's connection attempt plus its initial tool sync, in milliseconds (default 30000). */
  startupTimeoutMs: number
}

/** One server's child instance and any cleanup failure retained by the manager. */
interface ManagedRecord {
  /** Client configuration the instance mounts, retained for change detection. */
  entrySnapshot: McpClient.Config
  /** The child mcp-client fiber. */
  handle: Fiber
  failure?: McpCloseResult
  /** Set when unmount begins: late activation callbacks must publish nothing. */
  retired?: boolean
  /** Disposer of the status-cell subscription, once attached. */
  detachStatus?: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The MCP server manager. */
    mcpServers: McpServerManager
  }
}

/** The manager service. Reconciliation and `restart` serialize instance replacement. */
export default class McpServerManager extends TypertRemoteService {
  /** Schema for {@link Config}. */
  static Config: z<Partial<Config>, Config> = z.object({
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  })

  static inject = ['tools']

  private readonly ownerContext: Context
  private readonly instances = new Map<string, ManagedRecord>()
  private readonly statuses = new Map<string, McpManagedServerStatus>()
  /** Client configurations of plugin-contributed servers, each owned by its registering plugin's effect. */
  private readonly registrations = new Map<string, McpClient.Config>()
  /** Wake callbacks of active `watch` streams. */
  private readonly watchers = new Set<() => void>()
  /** Aborted at service dispose so `watch` streams end. */
  private readonly lifetime = new AbortController()
  /** Settled operation tail serializing every lifecycle operation. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Set at service dispose: refuse new operations while queued ones drain. */
  private stopped = false

  /**
   * Bind the manager to its plugin context.
   * @param ctx - the manager's plugin context; children mount under its fiber.
   * @param config - resolved manager configuration.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'mcpServers')
    this.ownerContext = ctx
  }

  /** Stop at final disposal; teardown unmounts every instance, retaining cleanup failures in the readable status registry. */
  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.stop()
      // The tail never rejects: every enqueue swallows its own settlement.
      await this.tail
      for (const [name, record] of [...this.instances]) await this.unmount(name, record)
    }
    const owner = this.ctx.fiber
    this.ctx.on('internal/plugin', (fiber) => {
      if (fiber === owner && fiber.uid === null) this.stop()
    }, { global: true })
  }

  /**
   * Read registered servers and retained runtime records without mounting.
   * @returns registered servers in registration order, then retained records for removed registrations.
   */
  list(): McpManagedServerView[] {
    return [...new Set([...this.registrations.keys(), ...this.instances.keys()])].map(name => ({
      name,
      status: this.statuses.get(name) ?? { state: 'connecting', attempt: 0 },
    }))
  }

  /**
   * Contribute one server for the calling plugin's lifetime. Its removal
   * awaits the instance's unmount, so plugin disposal withdraws the server's
   * tools before settling.
   * @param name - server key and tool namespace, unique among registered servers.
   * @param entry - the server endpoint.
   * @returns an idempotent disposer that removes the registration.
   * @throws when the name is invalid or taken, or the manager is disposed.
   */
  register(name: string, entry: McpServerRegistration): () => void {
    // The client schema fills its defaults and rejects an invalid name here, at registration.
    // Non-strict startup exposes connection failures through status.
    const config = McpClient.Config({
      transport: 'streamable-http',
      serverName: name,
      url: entry.url,
      failOnStartupError: false,
      startupTimeoutMs: this.config.startupTimeoutMs,
    })
    const dispose = this.ctx.effect(() => {
      if (this.stopped) throw new Error('mcp-manager: the manager is disposed')
      if (this.registrations.has(name)) throw new Error(`mcp-manager: server "${name}" is already registered`)
      this.registrations.set(name, config)
      void this.entriesChanged(`registration of "${name}"`)
      return () => {
        this.registrations.delete(name)
        // A stopping manager unmounts every instance itself.
        if (!this.stopped) return this.entriesChanged(`removal of "${name}"`)
      }
    }, 'mcpServers.register()')
    return () => void dispose()
  }

  /**
   * Stream server views for a management surface: the current list on
   * subscription, then the complete list again after each status or registration change.
   * @param signal - subscription lifetime; aborting ends only this stream.
   * @returns coalesced server lists until the subscriber or the manager stops.
   */
  @Remote({ mode: 'stream' })
  async* watch(signal: AbortSignal): AsyncIterable<McpManagedServerView[]> {
    const ended = AbortSignal.any([signal, this.lifetime.signal])
    // Read through a call: the flag changes while the stream awaits.
    const aborted = (): boolean => ended.aborted
    let wake = Promise.withResolvers<void>()
    let dirty = true
    const notify = (): void => {
      dirty = true
      wake.resolve()
    }
    this.watchers.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!dirty) await wake.promise
        if (aborted()) break
        dirty = false
        wake = Promise.withResolvers<void>()
        yield this.list()
      }
    } finally {
      this.watchers.delete(notify)
      ended.removeEventListener('abort', notify)
    }
  }

  /**
   * Rebuild one server: dispose the live instance (if any) and mount a fresh
   * one with a fresh reconnect budget. Incomplete cleanup blocks replacement
   * until the Host restarts.
   * @param name - the registered server key.
   * @throws when the manager is disposed, no such registration exists, or cleanup is incomplete.
   */
  @Remote
  async restart(name: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.registrations.has(name)) throw new Error(`mcp-manager: unknown server "${name}" — no plugin registers it`)
      await this.remount(name)
    })
  }

  private retire(record: ManagedRecord): void {
    record.retired = true
    record.detachStatus?.()
  }

  private stop(): void {
    this.stopped = true
    this.lifetime.abort()
    for (const record of this.instances.values()) this.retire(record)
  }

  /** Retire records whose registration changed or disappeared, then queue reconciliation. */
  private entriesChanged(what: string): Promise<void> {
    for (const [name, record] of this.instances) {
      if (!deepEqualJson(record.entrySnapshot, this.registrations.get(name))) this.retire(record)
    }
    this.changed()
    return this.schedule(() => this.reconcileOnce(), what)
  }

  /** Wake every `watch` stream. */
  private changed(): void {
    for (const notify of this.watchers) notify()
  }

  /** Queue one lifecycle operation on the serialized tail and contain its failure. */
  private schedule(op: () => Promise<void>, what: string): Promise<void> {
    return this.enqueue(op).catch((error: unknown) => {
      this.ctx.logger.error(`mcp-manager: ${what} failed`)
      this.ctx.logger.error(error)
    })
  }

  /** Serialize one operation behind every queued predecessor. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.stopped) {
        throw new Error('mcp-manager: the manager is disposed')
      }
      return op()
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Reconcile the live instance set against the current registrations. */
  private async reconcileOnce(): Promise<void> {
    // Registration changes retire their records, so a live record is current.
    for (const [name, record] of this.instances) {
      if (!record.retired) continue
      await this.unmount(name, record)
    }
    for (const name of this.statuses.keys()) {
      if (!this.registrations.has(name) && !this.instances.has(name)) this.statuses.delete(name)
    }
    this.changed()
    // A remaining record is either live or retains a cleanup failure.
    for (const [name, entry] of this.registrations) {
      if (!this.instances.has(name)) this.mount(name, entry)
    }
  }

  private async remount(name: string): Promise<void> {
    const record = this.instances.get(name)
    if (record !== undefined && !await this.unmount(name, record)) {
      throw new Error(`mcp-manager: cleanup for "${name}" is incomplete; restart the Host`)
    }
    const entry = this.registrations.get(name)
    if (entry === undefined || this.stopped) return
    this.mount(name, entry)
  }

  private mount(name: string, entry: McpClient.Config): void {
    // Disposal can overtake a reconcile while it awaits an unmount.
    if (this.stopped) return
    this.setStatus(name, { state: 'connecting', attempt: 0 })
    const handle = this.ownerContext.plugin(McpClient, entry)
    const record: ManagedRecord = { entrySnapshot: entry, handle }
    this.instances.set(name, record)
    void handle.await().then(() => {
      if (record.retired) return
      const cell = connectionStatusOf(handle)
      /* v8 ignore next -- successful MCP activation installs its status cell before becoming ready */
      if (cell === undefined) throw new Error(`mcp-manager: "${name}" activated without connection status`)
      const publish = (): void => {
        if (record.retired) return
        const status = cell.current()
        // The supervisor publishes nothing after an unclosed generation stops it.
        if (status.state === 'failed' && status.reason === 'unclosed-generation') this.retainCleanupFailure(record, cell.closure())
        this.setStatus(name, status)
      }
      record.detachStatus = cell.onChange(publish)
      publish()
    }).catch((error: unknown) => {
      // Disposal retires every record.
      if (record.retired) return
      void this.schedule(async () => {
        if (record.retired) return
        // A child that failed activation opened no connection, so its unmount completes.
        await this.unmount(name, record)
        this.setStatus(name, { state: 'failed', reason: 'load', lastError: String(error) })
      }, `failed startup of "${name}"`)
    })
  }

  private async unmount(name: string, record: ManagedRecord): Promise<boolean> {
    this.retire(record)
    await record.handle.dispose()
    const result = connectionStatusOf(record.handle)?.closure()
    if (result !== undefined && (!result.closeConfirmed || result.cleanupError !== undefined)) this.retainCleanupFailure(record, result)
    if (record.failure !== undefined) {
      this.setStatus(name, { state: 'failed', reason: 'cleanup', result: record.failure })
      return false
    }
    this.instances.delete(name)
    return true
  }

  /** Retain the first cleanup diagnostic and every unconfirmed transport closure. */
  private retainCleanupFailure(record: ManagedRecord, result: McpCloseResult): McpCloseResult {
    return record.failure = { ...result, ...record.failure,
      closeConfirmed: result.closeConfirmed && record.failure?.closeConfirmed !== false }
  }

  /**
   * Publish a changed status; the next reconcile drops the status of a removed
   * registration whose record is gone.
   */
  private setStatus(name: string, status: McpManagedServerStatus): void {
    const previous = this.statuses.get(name)
    if (previous !== undefined && deepEqualJson(previous, status)) return
    this.statuses.set(name, status)
    this.changed()
  }
}
