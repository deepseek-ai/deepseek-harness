/** Public pairing-request data; display codes never authenticate an applicant. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one process-local pairing request. */
export type PairingRequestId = Branded<'PairingRequestId'>

/** Browser-generated identity retained across creation retries and cancellation. */
export interface PairingCredential {
  readonly id: PairingRequestId
  /** Random credential, never the human-readable pairing code. */
  readonly secret: string
}

/** Request awaiting the owner's comparison of the displayed code. */
export interface PendingPairingRequest {
  readonly id: PairingRequestId
  readonly code: string
  /** Listener-protocol origin to which the applicant's ticket is bound. */
  readonly authority: string
  /** IP observed on the creating HTTP connection; null when unavailable. Forwarded headers are ignored. */
  readonly sourceIp: string | null
  readonly expiresInMs: number
}

/** Private ticket returned only to the requesting browser. */
export interface PairingTicket extends PendingPairingRequest, PairingCredential {
  readonly pollIntervalMs: number
}

/** Owner's decision after comparing the two displayed codes. */
export type PairingDecision = 'allow' | 'deny'

/** First committed decision, or a request no longer available for approval. */
export type PairingDecisionResult = 'approved' | 'denied' | 'unavailable'

/** Pending approval rows and the minimum refresh interval. */
export interface PairingRequestsValue {
  readonly requests: readonly PendingPairingRequest[]
  readonly pollIntervalMs: number
}

/** Anonymous response; the approved Cookie is carried only in Set-Cookie. */
export type PairingStatus = 'pending' | 'denied' | 'cancelled' | 'expired' | 'slow-down' | 'completed' | 'unavailable'
