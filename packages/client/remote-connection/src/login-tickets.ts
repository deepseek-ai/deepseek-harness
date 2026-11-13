/** One service-owned, single-use browser login invitation. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteLoginId, RemoteLoginState, RemoteLoginTicket } from './types.ts'
import { encodeBase64Url } from './base64.ts'

type Ticket = {
  readonly id: RemoteLoginId
  readonly expiresAt: number
} & (
  | { readonly kind: 'pending'; readonly digest: Buffer }
  | { readonly kind: 'used' | 'expired' | 'cancelled' }
)

/** One outstanding invitation; regeneration replaces it without retaining credentials. */
export class LoginTickets {
  private ticket: Ticket | undefined

  /**
   * Replace the outstanding invitation with a fresh random credential.
   * @param root - advertised application directory URL.
   * @param lifetimeMs - validated invitation lifetime.
   * @returns the only response carrying the plaintext credential.
   */
  create(root: string, lifetimeMs: number): RemoteLoginTicket {
    const token = encodeBase64Url(randomBytes(32))
    const id = brandString<RemoteLoginId>(randomUUID())
    const expiresAt = Date.now() + lifetimeMs
    const url = new URL(root)
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    url.search = '?login=qr'
    url.hash = token
    // Version 40 with medium error correction carries at most 2331 byte-mode bytes.
    if (Buffer.byteLength(url.href, 'utf8') > 2331) {
      throw new RemoteError('remote-connection/url-too-long', 'The application URL exceeds QR code capacity.', {})
    }
    this.ticket = { kind: 'pending', id, expiresAt, digest: digest(token) }
    return { id, url: url.href, lifetimeMs }
  }

  /**
   * Read an invitation without revealing its credential.
   * @param id - requested invitation, or null to read no invitation.
   * @returns current state; an identifier displaced by regeneration is replaced.
   */
  state(id: RemoteLoginId | null): RemoteLoginState {
    if (id === null) return 'none'
    this.expire()
    return this.ticket?.id === id ? this.ticket.kind : 'replaced'
  }

  /**
   * Invalidate only the named invitation; stale cancellation cannot cancel a replacement.
   * @param id - invitation to cancel.
   */
  cancel(id: RemoteLoginId): void {
    this.expire()
    const ticket = this.ticket
    if (ticket?.id === id && ticket.kind === 'pending') {
      this.ticket = { kind: 'cancelled', id, expiresAt: ticket.expiresAt }
    }
  }

  /**
   * Atomically validate and consume the credential before issuing a browser session.
   * @param token - credential supplied by the anonymous HTTP exchange.
   * @returns true for its sole successful exchange; all other attempts leave it unusable or unchanged.
   */
  consume(token: string): boolean {
    this.expire()
    const ticket = this.ticket
    if (ticket?.kind !== 'pending' || !timingSafeEqual(ticket.digest, digest(token))) return false
    this.ticket = { kind: 'used', id: ticket.id, expiresAt: ticket.expiresAt }
    return true
  }

  /** Remove the outstanding credential when its owning plugin unloads. */
  dispose(): void {
    this.ticket = undefined
  }

  private expire(): void {
    const ticket = this.ticket
    if (ticket?.kind === 'pending' && Date.now() >= ticket.expiresAt) {
      this.ticket = { kind: 'expired', id: ticket.id, expiresAt: ticket.expiresAt }
    }
  }
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}
