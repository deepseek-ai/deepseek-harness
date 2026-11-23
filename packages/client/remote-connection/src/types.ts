/** Browser login invitations and deployment availability. */
import type { Branded } from '@deepseek-ai/dsh-brand'

export type * from './pairing-types.ts'

/** Identifier used to inspect or cancel an invitation; it cannot authorize login. */
export type RemoteLoginId = Branded<'remote-login-id'>

/** Deployment prerequisite preventing QR login. */
export type RemoteConnectionUnavailable = 'unreachable-host' | 'untrusted-host'

/** State of the invitation requested by the settings panel. */
export type RemoteLoginState = 'none' | 'pending' | 'used' | 'expired' | 'cancelled' | 'replaced'

/** Settings projection; it never contains an invitation's secret. */
export interface RemoteConnectionStatus {
  /** Clean advertised application URL. */
  readonly url: string
  /** Whether the advertised URL is reachable and trusted for QR login. */
  readonly availability: 'available' | RemoteConnectionUnavailable
  /** Whether the owner may request a login link from the Host's optional Token provider for this address. */
  readonly loginUrlAllowed: boolean
  /** State of the requested invitation, or none when no identifier was supplied. */
  readonly ticket: RemoteLoginState
  /** Interval between settings-panel status reads, in milliseconds. */
  readonly pollIntervalMs: number
}

/** One short-lived bearer invitation, returned only when created. */
export interface RemoteLoginTicket {
  /** Non-secret identifier for status reads and cancellation. */
  readonly id: RemoteLoginId
  /** Login page URL with the one-use credential in its fragment. */
  readonly url: string
  /** Lifetime in milliseconds, for browser countdowns independent of Host clock offset. */
  readonly lifetimeMs: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'remote-connection/owner-required': Record<string, never>
    'remote-connection/disposed': Record<string, never>
    'remote-connection/unavailable': { readonly reason: RemoteConnectionUnavailable }
    /** The optional Token provider did not publish a login URL for this application. */
    'remote-connection/token-unavailable': Record<string, never>
    'remote-connection/url-too-long': Record<string, never>
  }
}
