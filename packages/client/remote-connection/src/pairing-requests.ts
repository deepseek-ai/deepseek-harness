/** Bounded, process-local requests and repeatable delivery of an approved browser Cookie. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { PairingCredential, PairingDecision, PairingDecisionResult, PairingRequestId, PairingTicket, PendingPairingRequest } from './pairing-types.ts'

/** Deployment limits resolved by the plugin configuration before allocation. */
export interface PairingLimits {
  readonly requestTtlMs: number
  readonly maxRequests: number
  readonly requestIntervalMs: number
  readonly pollIntervalMs: number
}

type RequestOutcome =
  | { readonly status: 'pending' | 'denied' | 'cancelled' }
  | { readonly status: 'approved' }
  | { readonly status: 'completed'; readonly cookie: string }

interface PairingRecord {
  readonly id: PairingRequestId
  readonly code: string
  readonly secret: string
  readonly authority: string
  readonly sourceIp: string | null
  readonly expiresAt: number
  nextPollAt: number
  outcome: RequestOutcome
}

/** State result consumed by the HTTP response owner. */
export type PairingPoll =
  | { readonly status: 'pending' | 'denied' | 'cancelled' | 'expired' | 'slow-down' | 'unavailable' }
  | { readonly status: 'completed'; readonly cookie: string }

/** Owns one plugin activation's private request tickets and decisions. */
export class PairingRequests {
  private readonly records = new Map<PairingRequestId, PairingRecord>()
  private nextCreationAt = 0

  /** @param limits - complete, validated request lifetime, capacity, and cadence. */
  constructor(private readonly limits: PairingLimits) {}

  /**
   * Allocate one ticket; repeating its identity returns the retained ticket without renewing it.
   * Repeated creation cannot change an existing approval, denial, cancellation, or Cookie.
   * @param authority - normalized origin accepted by WebServer admission.
   * @param sourceIp - normalized IP observed on the creating connection, or null when unavailable.
   * @param credential - browser-generated identity and secret retained before the first HTTP request.
   * @returns ticket, or undefined on a credential conflict, creation rate limit, or full pool.
   */
  create(authority: string, sourceIp: string | null, credential: PairingCredential): PairingTicket | undefined {
    this.prune()
    const existing = this.records.get(credential.id)
    if (existing !== undefined) {
      if (existing.authority !== authority || !matches(credential.secret, existing.secret)) return undefined
      return { ...this.publicValue(existing), secret: existing.secret, pollIntervalMs: this.limits.pollIntervalMs }
    }
    const now = Date.now()
    if (now < this.nextCreationAt || this.records.size >= this.limits.maxRequests) return undefined
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    let code: string
    do {
      code = Array.from(randomBytes(8), byte => alphabet[byte & 31]).join('')
    } while (Array.from(this.records.values()).some(record => record.code === code))
    const record: PairingRecord = {
      ...credential, code, authority, sourceIp,
      expiresAt: now + this.limits.requestTtlMs,
      nextPollAt: now + this.limits.pollIntervalMs,
      outcome: { status: 'pending' },
    }
    this.records.set(record.id, record)
    this.nextCreationAt = now + this.limits.requestIntervalMs
    return { ...this.publicValue(record), secret: record.secret, pollIntervalMs: this.limits.pollIntervalMs }
  }

  /**
   * Read only pending, unexpired requests without their private credentials.
   * @returns rows the owner can approve or deny.
   */
  list(): PendingPairingRequest[] {
    this.prune()
    return Array.from(this.records.values()).filter(record => record.outcome.status === 'pending')
      .map(record => this.publicValue(record))
  }

  /**
   * Keep the first decision when owner devices race or retry after a lost response.
   * @param id - request selected after comparing the displayed code.
   * @param decision - allow or deny access as the owner.
   * @returns committed decision or unavailable for an expired, cancelled, or collected request.
   */
  decide(id: PairingRequestId, decision: PairingDecision): PairingDecisionResult {
    this.prune()
    const record = this.records.get(id)
    if (record === undefined) return 'unavailable'
    if (record.outcome.status === 'pending') record.outcome = { status: decision === 'allow' ? 'approved' : 'denied' }
    return record.outcome.status === 'approved' || record.outcome.status === 'denied' ? record.outcome.status : 'unavailable'
  }

  /**
   * Read or cancel one ticket; only approval can sign a Cookie, once per ticket.
   * A failed signer leaves the approval intact. A lost delivery can be retried with
   * the same secret until expiry, receiving the same Cookie without extending it.
   * @param id - applicant's request identity.
   * @param secret - private ticket credential, never the display code.
   * @param authority - origin of this request, which must match ticket creation.
   * @param cancel - withdraw before approved delivery completes.
   * @param issueCookie - Remote credential issuer for the current request.
   * @returns request state and, only after approval, its retained Cookie.
   */
  poll(id: PairingRequestId, secret: string, authority: string, cancel: boolean, issueCookie: () => string | undefined): PairingPoll {
    this.prune()
    const record = this.records.get(id)
    if (record === undefined || record.authority !== authority || !matches(secret, record.secret)) return { status: 'expired' }
    if (cancel && record.outcome.status !== 'completed' && record.outcome.status !== 'denied') record.outcome = { status: 'cancelled' }
    if (!cancel && Date.now() < record.nextPollAt) return { status: 'slow-down' }
    record.nextPollAt = Date.now() + this.limits.pollIntervalMs
    if (record.outcome.status === 'approved') {
      const cookie = issueCookie()
      if (cookie === undefined) return { status: 'unavailable' }
      record.outcome = { status: 'completed', cookie }
    }
    return record.outcome
  }

  /** Remove every private ticket and retained Cookie when the plugin unloads. */
  clear(): void { this.records.clear() }

  private prune(): void {
    for (const [id, record] of this.records) if (record.expiresAt <= Date.now()) this.records.delete(id)
  }

  private publicValue(record: PairingRecord): PendingPairingRequest {
    return {
      id: record.id, code: record.code, authority: record.authority, sourceIp: record.sourceIp,
      expiresInMs: record.expiresAt - Date.now(),
    }
  }
}

function matches(actual: string, expected: string): boolean {
  const bytes = Buffer.from(actual)
  const target = Buffer.from(expected)
  return bytes.length === target.length && timingSafeEqual(bytes, target)
}
