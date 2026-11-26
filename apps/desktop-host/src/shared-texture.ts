/**
 * Desktop Host half of shared textures: the `sharedTexture` service. Capability and adapter queries travel over the
 * Electron child-process channel; frames, their delivery, and their settlement travel on the hop addon's native
 * connection to Main's ingress, submitted by a native addon through the connection's sink. Its one claimant never
 * touches Mach ports, Win32 handle transfer, or the native channel.
 */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import {
  SharedTexture as SharedTextureBase, type SharedTextureCapabilities, type SharedTextureClaim, type SharedTextureNativeSink,
} from '@deepseek-ai/dsh-shared-texture'
import type {
  SharedTextureHostMessage, SharedTextureHostRequest, SharedTextureMainCapabilities, SharedTextureMainReply,
} from './types.ts'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}
/** The cached connection to Main and the capabilities it was opened for. */
interface Connection {
  readonly desktop: SharedTextureMainCapabilities
  readonly hop: SharedTextureHopConnection
}

interface HopNative {
  /** `onEvent` runs once, when the connection ends other than through `close`. */
  connect(endpoint: string, onEvent: (event: { type: 'disconnected' }) => void): { native: object; sink: object }
  close(native: object): void
}

/** One hop connection to Main's ingress. Losing or closing it settles every unsettled frame as invalidated. */
interface SharedTextureHopConnection {
  /** Native object through which same-process addons submit frames on this connection. */
  readonly sink: SharedTextureNativeSink
  /** End the connection without calling `onDisconnect`; repeated calls do nothing. */
  close(): void
}

/** Operations of the loaded hop addon. */
interface SharedTextureHopAddon {
  /**
   * Connect to Main's ingress.
   * @param endpoint - Endpoint from Main's capabilities.
   * @param onDisconnect - Called once when the connection ends other than through `close`.
   * @returns The open connection; throws when the endpoint cannot be reached.
   */
  connect(endpoint: string, onDisconnect: () => void): SharedTextureHopConnection
}

/** Main formats an adapter LUID as two unpadded lowercase hexadecimal 32-bit halves. */
const ADAPTER_LUID = /^[0-9a-f]{1,8}:[0-9a-f]{1,8}$/

/**
 * Load the hop addon Main names in its capabilities.
 * @param path - Addon path from Main's capabilities.
 * @returns Hop operations; throws if Main named no addon or it cannot load.
 */
export function loadSharedTextureHop(path: string | undefined): SharedTextureHopAddon {
  if (path === undefined) throw new Error('Desktop reported no shared-texture hop addon')
  const addon = createRequire(import.meta.url)(path) as HopNative
  return {
    connect(endpoint, onDisconnect) {
      let closed = false
      /** The native connection is released once, whether the hop lost it or the service closes it. */
      const end = (): void => {
        closed = true
        addon.close(native)
      }
      const { native, sink } = addon.connect(endpoint, () => {
        if (closed) return
        end()
        onDisconnect()
      })
      return {
        // The sink is a `napi_external`, opaque to JavaScript.
        sink: sink as SharedTextureNativeSink,
        close() { if (!closed) end() },
      }
    },
  }
}

/** Electron Main is the only producer; a message that breaks the envelope means the channel cannot be trusted. */
function parseMessage(message: unknown): SharedTextureMainReply | 'other' | 'malformed' {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'shared-texture') return 'other'
  if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return 'malformed'
  if ('error' in message && message.error !== undefined && typeof message.error !== 'string') return 'malformed'
  return message as SharedTextureMainReply
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Desktop shared-texture reply')
  return value as Record<string, unknown>
}

/**
 * Correlates Host controls with Main replies and keeps one native connection to Main; after a disconnect or an
 * untrusted message, every request rejects and the connection closes. Only the holder of the claim reaches the
 * operations.
 */
export class SharedTexture extends SharedTextureBase {
  private nextRequestId = 1
  private readonly pending = new Map<number, Pending>()
  private hop: { addon: SharedTextureHopAddon; path: string } | undefined
  /**
   * The connection to Main's ingress, opened on first use and kept until it is lost, Main's capabilities change, or a
   * claim that took its native sink ends.
   */
  private connection: Connection | undefined
  private connecting: Promise<Connection> | undefined
  private closed = false
  private claimed: SharedTextureClaim | undefined

  /**
   * @param ctx - Desktop Host scope.
   * @param loadHop - Load the hop addon; {@link loadSharedTextureHop} in the application.
   */
  constructor(ctx: Context, private readonly loadHop: (path: string | undefined) => SharedTextureHopAddon) {
    super(ctx)
    const receive = (message: unknown): void => { this.receive(message) }
    const disconnect = (): void => { this.rejectAll() }
    ctx.effect(() => {
      process.on('message', receive)
      process.on('disconnect', disconnect)
      return () => {
        process.off('message', receive)
        process.off('disconnect', disconnect)
        this.rejectAll()
      }
    })
  }

  /** Main can no longer be reached or trusted: closing the connection settles its unsettled frames as invalidated. */
  private rejectAll(): void {
    this.closed = true
    for (const request of this.pending.values()) request.reject(new Error('Desktop shared textures disconnected'))
    this.pending.clear()
    if (this.connection !== undefined) this.drop(this.connection)
  }

  /** A reply whose request already ended, through its deadline or a send failure, is dropped. */
  private receive(message: unknown): void {
    const parsed = parseMessage(message)
    if (parsed === 'other') return
    if (parsed === 'malformed') { this.rejectAll(); return }
    const request = this.pending.get(parsed.requestId)
    if (request === undefined) return
    if (parsed.error === undefined) request.resolve(parsed.value)
    else request.reject(new Error(parsed.error))
  }

  /**
   * @param request - Host request.
   * @param timeoutMs - Deadline in milliseconds for Main's reply.
   * @returns Main's reply value.
   */
  private async request(request: SharedTextureHostRequest, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new Error('Desktop shared textures disconnected')
    const requestId = this.nextRequestId++
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<unknown>((resolve, reject) => {
        if (!process.connected || process.send === undefined) throw new Error('Desktop shared textures are unavailable')
        this.pending.set(requestId, { resolve, reject })
        timeout = setTimeout(() => { reject(new Error('Desktop shared-texture request timed out')) }, timeoutMs)
        timeout.unref()
        const message: SharedTextureHostMessage = { type: 'shared-texture', requestId, request }
        process.send(message, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timeout)
      this.pending.delete(requestId)
    }
  }

  override claim(): SharedTextureClaim {
    if (this.claimed !== undefined) throw new Error('Desktop shared textures are already claimed')
    const held = (): void => { if (this.claimed !== claim) throw new Error('Desktop shared-texture claim was released') }
    /** Connections whose native sink this claim handed out; JavaScript cannot revoke one, so they close with the claim. */
    const sinks = new Set<Connection>()
    const claim: SharedTextureClaim = {
      capabilities: async (timeoutMs) => { held(); return this.capabilities(timeoutMs) },
      nativeSink: async (timeoutMs) => {
        held()
        const connection = await this.connected(timeoutMs)
        held()
        sinks.add(connection)
        return connection.hop.sink
      },
      adapterLuid: async (timeoutMs) => { held(); return this.adapterLuid(timeoutMs) },
      release: () => { void release() },
    }
    // `this.ctx` is the scope that read this service, so disposing that scope releases the claim.
    const release = this.ctx.effect(() => {
      this.claimed = claim
      return () => {
        this.claimed = undefined
        for (const connection of sinks) this.drop(connection)
      }
    }, 'sharedTexture.claim()')
    return claim
  }

  /** Close a connection that is still cached; a lost or replaced one is already closed. */
  private drop(connection: Connection): void {
    if (this.connection !== connection) return
    this.connection = undefined
    connection.hop.close()
  }

  /** @returns Main's current support report without the fields only this service uses to reach Main. */
  private async capabilities(timeoutMs: number): Promise<SharedTextureCapabilities> {
    const { supported, reason, pid, ingress } = await this.queryCapabilities(timeoutMs)
    const connection = this.connection
    const changed = !supported || connection?.desktop.pid !== pid || connection.desktop.ingress?.endpoint !== ingress?.endpoint
    if (connection !== undefined && changed) this.drop(connection)
    return { supported, ...reason === undefined ? {} : { reason } }
  }

  private async queryCapabilities(timeoutMs: number): Promise<SharedTextureMainCapabilities> {
    const value = record(await this.request({ op: 'capabilities' }, timeoutMs))
    const { supported, reason, pid, hop, ingress } = value
    if (typeof supported !== 'boolean'
      || (reason !== undefined && typeof reason !== 'string') || !Number.isSafeInteger(pid) || typeof pid !== 'number' || pid < 1
      || (hop !== undefined && (typeof record(hop).addon !== 'string' || record(hop).addon === ''))
      || (ingress !== undefined && (typeof record(ingress).endpoint !== 'string' || record(ingress).endpoint === ''))) {
      throw new Error('Invalid Desktop shared-texture capabilities')
    }
    return {
      supported, pid,
      ...reason === undefined ? {} : { reason },
      ...hop === undefined ? {} : { hop: { addon: record(hop).addon as string } },
      ...ingress === undefined ? {} : { ingress: { endpoint: record(ingress).endpoint as string } },
    }
  }

  /** @returns The cached connection, or a new one to the ingress Main currently reports; concurrent callers share one attempt. */
  private connected(timeoutMs: number): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('Desktop shared textures disconnected'))
    if (this.connection !== undefined) return Promise.resolve(this.connection)
    this.connecting ??= this.connect(timeoutMs).finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connect(timeoutMs: number): Promise<Connection> {
    const desktop = await this.queryCapabilities(timeoutMs)
    if (this.closed) throw new Error('Desktop shared textures disconnected')
    if (!desktop.supported) throw new Error(`Desktop shared textures are unavailable: ${desktop.reason ?? 'unsupported'}`)
    if (desktop.hop === undefined || desktop.ingress === undefined) throw new Error('Desktop reported no shared-texture hop addon or ingress')
    if (this.hop?.path !== desktop.hop.addon) this.hop = { addon: this.loadHop(desktop.hop.addon), path: desktop.hop.addon }
    let connection: Connection | undefined = undefined
    const hop = this.hop.addon.connect(desktop.ingress.endpoint, () => {
      if (connection !== undefined && this.connection === connection) this.connection = undefined
    })
    connection = { desktop, hop }
    this.connection = connection
    return connection
  }

  /** Main reads the adapter of its own compositor texture, so the query needs no native connection. */
  private async adapterLuid(timeoutMs: number): Promise<string | null> {
    // Only Chromium's Windows compositor exports Direct3D textures whose adapter Main can read.
    if (process.platform !== 'win32') return null
    const value = await this.request({ op: 'adapter-luid', timeoutMs }, timeoutMs)
    if (value !== null && (typeof value !== 'string' || !ADAPTER_LUID.test(value))) throw new Error('Invalid Desktop shared-texture adapter')
    return value
  }
}

/** Loader identity of the Desktop Host shared-texture service. */
export const name = 'desktop-shared-texture'

/** Register the Desktop Host shared-texture service.
 * @param ctx - Desktop Host scope.
 */
export function apply(ctx: Context): void {
  new SharedTexture(ctx, loadSharedTextureHop)
}
