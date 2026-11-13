/** Ordered credential verification, independent of Connection's transport and source policy. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthenticationProvider, ConnectionTrustRequest, PeerAdmission } from './rpc.ts'

/** Credential verifier registry whose registrations belong to the calling plugin. */
export class ConnectionAuthentication extends Service {
  private readonly providers = new Set<{ readonly provider: AuthenticationProvider }>()
  private readonly owner: Context
  private disposed = false

  /** @param ctx - scope owning the credential registry and its lifetime. */
  constructor(ctx: Context) {
    super(ctx, 'connection.authentication')
    this.owner = ctx
    ctx.effect(() => () => {
      this.disposed = true
      this.providers.clear()
    }, 'client-connection: authentication registry')
  }

  /**
   * Add a credential verifier after the existing registrations.
   * @param provider - verifier owning its credential and Peer selection.
   * @returns disposer withdrawing this registration; the calling scope also withdraws it on unload.
   */
  register(provider: AuthenticationProvider): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.disposed || this.owner.fiber.uid === null) throw new Error('connection: authentication registry is disposed')
      const entry = { provider }
      this.providers.add(entry)
      return () => { this.providers.delete(entry) }
    }, 'client-connection: authentication provider')
  }

  /**
   * Verify credentials without applying an HTTP response or source policy.
   * @param request - current carrier headers and cancellation facts.
   * @returns the first live Peer, 401 if no provider accepts, or 503 when verification failed without success.
   */
  authenticate(request: ConnectionTrustRequest): PeerAdmission {
    if (this.disposed || this.owner.fiber.uid === null || request.signal?.aborted || request.socket?.destroyed) return { rejection: 401 }
    let failed = false
    for (const entry of [...this.providers]) {
      if (!this.providers.has(entry)) continue
      let peer: PeerScope | undefined
      try { peer = entry.provider.authenticate(request) } catch (error) {
        this.owner.logger.warn('Connection authentication provider failed', error)
        failed = true
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- verification may reenter and dispose the owner.
      if (this.disposed || this.owner.fiber.uid === null || request.signal?.aborted || request.socket?.destroyed) return { rejection: 401 }
      if (this.providers.has(entry) && peer !== undefined && !peer.signal.aborted) return { peer }
    }
    return { rejection: failed ? 503 : 401 }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Credential verification shared by Host transports and authentication plugins. */
    'connection.authentication': ConnectionAuthentication
  }
}

declare module './rpc.ts' {
  interface HostConnectionHandle {
    /** Credential verifier sub-service; consumers inject `connection.authentication`. */
    readonly authentication: ConnectionAuthentication
  }
}

export default ConnectionAuthentication
