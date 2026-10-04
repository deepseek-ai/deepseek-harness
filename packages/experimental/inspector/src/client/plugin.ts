/** Client Cordis plugin that publishes browser observations directly to the Inspector Worker. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { InspectorClientBootstrap } from '../shared/bridge/messages/control.ts'
import { INSPECTOR_BOOTSTRAP_ROUTE } from '../shared/web.ts'
import { parseInspectorClientBootstrap } from '../shared/bridge/control-codec.ts'
import { createInspectorService, type InspectorService as SharedInspectorService } from '../shared/service.ts'
import { publishCordisTree } from './inspection/cordis.ts'
import { startInspectorClient } from './bridge/controller.ts'
import { disposeInspectorResources } from '../shared/dispose.ts'

export type { CordisRuntimeTreeReader } from '../shared/cordis/reader.ts'
export type {
  CordisRuntimeConnection,
  CordisRuntimeContext,
  CordisRuntimeFiber,
  CordisRuntimeNode,
  CordisRuntimeRealm,
  CordisRuntimeSource,
  CordisRuntimeTree,
} from '../shared/cordis/model.ts'

/** Client-facing Inspector service backed by the shared implementation. */
export interface InspectorService extends SharedInspectorService {}

declare global {
  /** Host-injected Inspector Client connection parameters. */
  var __DSH_INSPECTOR__: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Publish Client-realm observations and query the shared Inspector state. */
    inspector: InspectorService
  }
}

/** Cordis plugin name shared with the Host face. */
export const name = 'experimental-inspector'

/** This transport root has no Client service dependencies. */
export const inject: string[] = []

/**
 * Mount the Client source, including when the plugin activates after the page loads.
 * @param ctx - Client Cordis context whose page identity and lifecycle own the source.
 * @throws Invalid bootstrap data or a failed service registration; transport setup failures retain reconnect recovery.
 */
export async function apply(ctx: Context): Promise<void> {
  const session = new InspectorClientSession(ctx)
  ctx.effect(() => () => session.dispose(), 'experimental-inspector: Client lifetime')
  ctx.on('connection/reset', () => {
    void session.refresh().catch((error: unknown) => {
      ctx.logger.warn('experimental-inspector: Client connection failed; reconnect or reload the page to retry', error)
    })
  })
  const injected = globalThis.__DSH_INSPECTOR__
  if (injected !== undefined) await session.connect(parseInspectorClientBootstrap(injected))
  else await session.refresh()
}

/**
 * Owns each source and its tree publisher until replacement or the outer lifetime effect disposes it.
 * Cordis owns service/listener effects; transport setup failures retain the reset listener for retry.
 * Invalid bootstrap data and registration errors reject startup after rollback.
 */
class InspectorClientSession {
  private readonly lifetime = new AbortController()
  private pending: Promise<void> = Promise.resolve()
  private bootstrap: InspectorClientBootstrap | undefined
  private release: (() => Promise<void>) | undefined

  constructor(private readonly ctx: Context) {}

  refresh(): Promise<void> {
    return this.enqueue(() => this.readBootstrap())
  }

  connect(bootstrap: InspectorClientBootstrap): Promise<void> {
    return this.enqueue(() => this.replace(bootstrap))
  }

  private async readBootstrap(): Promise<void> {
    let response: Response
    try {
      response = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal })
    } catch (error) {
      this.connectionFailed(error)
      return
    }
    if (!response.ok) {
      this.connectionFailed(new Error(`Inspector bootstrap failed: HTTP ${response.status}`))
      return
    }
    const value: unknown = await response.json()
    await this.replace(parseInspectorClientBootstrap(value))
  }

  private connectionFailed(error: unknown): void {
    if (this.lifetime.signal.aborted) return
    this.ctx.logger.warn('experimental-inspector: Client connection failed; reconnect or reload the page to retry', error)
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.pending.then(() => {
      this.lifetime.signal.throwIfAborted()
      return task()
    })
    this.pending = pending.catch((error: unknown) => { void error /* The caller owns failure reporting. */ })
    return pending
  }

  private async replace(bootstrap: InspectorClientBootstrap): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (this.bootstrap?.endpoint === bootstrap.endpoint && this.bootstrap.protocol === bootstrap.protocol) return
    await this.release?.()
    this.release = undefined
    this.bootstrap = undefined
    let source: Awaited<ReturnType<typeof startInspectorClient>>
    try {
      source = await startInspectorClient(bootstrap)
    } catch (error) {
      this.connectionFailed(error)
      return
    }
    const disposers: Array<() => unknown> = []
    const dispose = () => disposeInspectorResources(disposers, () => { source.close() }, 'experimental-inspector: Client disposal failed')
    try {
      this.lifetime.signal.throwIfAborted()
      disposers.push(publishCordisTree(this.ctx, source, {
        maxNodes: bootstrap.maxCordisNodes,
        maxBytes: bootstrap.maxFrameBytes - 4_096,
      }))
      disposers.push(this.ctx.provide('inspector', createInspectorService(source)))
      const panel = this.ctx.inject(['slots', 'shortcuts', 'locale'], async (ctx) => {
        const { registerInspectorPage } = await import('./bottom/page.tsx')
        registerInspectorPage(ctx, source.sourceId)
      })
      disposers.push(() => panel.dispose())
    } catch (error) {
      try {
        await dispose()
      } catch (cleanupError) {
        this.ctx.logger.error('experimental-inspector: Client initialization rollback failed', cleanupError)
      }
      throw error
    }
    this.bootstrap = bootstrap
    this.release = dispose
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.pending
    await this.release?.()
    this.release = undefined
  }
}
