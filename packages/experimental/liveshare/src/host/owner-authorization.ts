/**
 * The host's half of one owner-authorization: a transaction the page starts here, a single-use code the
 * Relay issues on its own origin, and the verifier only this host holds.
 *
 * The owner authorizes one DSH instance to be reported by one Relay address. The long-term credential
 * never travels through the browser: the owner signs in on the Relay in any browser, the Relay holds the
 * code it issues for this transaction, and this host collects that code and redeems it over TLS with the
 * PKCE verifier that never left the process. The page that began the transaction reads its settlement
 * here, and only from the origin the transaction bound. The Relay and instance are checked again at
 * redemption, and the transaction is consumed by exactly one completion.
 */

import { createHash, randomBytes } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { OwnerIdentityStatus } from '../owner-identity.ts'

/** Why one owner-authorization attempt was refused. */
export type OwnerAuthorizationRefusal =
  /** No transaction has this id, or it was already completed. */
  | 'unknown-transaction'
  /** The transaction outlived its deadline. */
  | 'expired'
  /** The address in force is not the one this transaction authorized. */
  | 'relay-changed'
  /** This host's instance is not the one the transaction was minted for. */
  | 'instance-changed'

/** How one transaction ended, as the page that began it reads it. */
export type OwnerLoginSettlement =
  | { readonly ok: true; readonly identity: OwnerIdentityStatus }
  /** `error` is a stable `owner-login-*` code the Owner client maps to copy. */
  | { readonly ok: false; readonly error: string }

/** What the page that began a transaction can learn about it now. */
export type OwnerLoginView =
  /** The Relay has issued no code yet, so this host collects it in this state. */
  | { readonly status: 'awaiting-code'; readonly transaction: OwnerAuthorizationTransaction }
  /** A code was collected and this host is exchanging it. */
  | { readonly status: 'redeeming' }
  | { readonly status: 'settled'; readonly settlement: OwnerLoginSettlement }

/** One transaction the host began and is waiting to complete. */
export interface OwnerAuthorizationTransaction {
  /**
   * Single-use identifier the Relay binds its code to.
   *
   * It is also the transaction's key, so the page carries exactly one opaque value: the handle it reads
   * the settlement with, the value the Relay holds the code under, and the handle this host completes with.
   */
  readonly state: string
  /** PKCE verifier, held only by this host; the Relay is given its S256 challenge. */
  readonly verifier: string
  readonly challenge: string
  /** Relay address this transaction authorizes, normalized. */
  readonly relay: string
  /** Host instance the credential will be minted for. */
  readonly instanceKey: string
  /** Exact page origin allowed to read the transaction. */
  readonly origin: string
  /** Epoch milliseconds after which the transaction is refused. */
  readonly expiresAt: number
}

/** What one completed transaction hands the redemption step. */
export interface CompletedOwnerAuthorization {
  readonly relay: string
  readonly instanceKey: string
  readonly verifier: string
}

/** Outcome of completing a transaction: the verifier and its bindings, or a stable refusal. */
export type OwnerAuthorizationOutcome =
  | { readonly ok: true; readonly completed: CompletedOwnerAuthorization }
  | { readonly ok: false; readonly code: OwnerAuthorizationRefusal }

/** One transaction at each point of its life. */
type OwnerLoginRecord =
  | { readonly status: 'awaiting-code'; readonly transaction: OwnerAuthorizationTransaction }
  | { readonly status: 'redeeming'; readonly origin: string; readonly retainUntil: number }
  | {
    readonly status: 'settled'
    readonly origin: string
    readonly retainUntil: number
    readonly settlement: OwnerLoginSettlement
  }

/** One authorization's lifetime; short because the owner completes it in the same sitting. */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** `base64url` without padding, the encoding PKCE specifies for both values. */
function base64url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * The transactions this host has begun, from minting through the settlement their pages read.
 *
 * Held in memory and keyed by id: a restart invalidates pending authorizations, which the owner retries
 * from the page rather than the host resurrecting one it can no longer vouch for. A settlement is retained
 * for one transaction lifetime after its completion, so a page that stopped asking leaves nothing behind
 * for longer than that.
 */
export class OwnerAuthorizations {
  private readonly records = new Map<string, OwnerLoginRecord>()

  /**
   * @param options - Clock and lifetime overrides for tests; production uses the defaults.
   */
  constructor(private readonly options: {
    readonly ttlMs?: number
    readonly now?: () => number
  } = {}) {}

  /** The clock this store judges expiry against. */
  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** One transaction lifetime, also the retention of a settlement after its completion. */
  private ttl(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS
  }

  /**
   * Begin one authorization for a Relay address, a host instance, and the page that asked.
   *
   * The verifier stays here and only its S256 challenge is published, so a code intercepted in transit is
   * useless without this process.
   * @param input - Relay address, host instance, and the exact page origin that began it.
   * @returns The transaction, whose state the page carries and whose challenge the Relay gets.
   */
  begin(input: { readonly relay: string; readonly instanceKey: string; readonly origin: string }): OwnerAuthorizationTransaction {
    this.sweep()
    const verifier = base64url(randomBytes(32))
    const transaction: OwnerAuthorizationTransaction = {
      state: base64url(randomBytes(16)),
      verifier,
      challenge: base64url(createHash('sha256').update(verifier).digest()),
      relay: input.relay,
      instanceKey: input.instanceKey,
      origin: input.origin,
      expiresAt: this.now() + this.ttl(),
    }
    this.records.set(transaction.state, { status: 'awaiting-code', transaction })
    return transaction
  }

  /**
   * Complete one authorization with the code the Relay issued, checking the bindings that may have moved.
   *
   * A changed Relay or instance leaves the transaction awaiting its code. A transaction that passes reads
   * as `redeeming` until {@link settle} records how its exchange ended.
   * @param input - The state the code was issued for, and the Relay address and host instance in force.
   * @returns The verifier with its bindings, or the stable code naming the refusal.
   */
  complete(input: { readonly state: string; readonly relay: string; readonly instanceKey: string }): OwnerAuthorizationOutcome {
    const record = this.records.get(input.state)
    if (record?.status !== 'awaiting-code') return { ok: false, code: 'unknown-transaction' }
    const transaction = record.transaction
    if (this.now() >= transaction.expiresAt) {
      this.records.delete(transaction.state)
      return { ok: false, code: 'expired' }
    }
    if (input.relay !== transaction.relay) return { ok: false, code: 'relay-changed' }
    if (input.instanceKey !== transaction.instanceKey) return { ok: false, code: 'instance-changed' }
    this.records.set(transaction.state, {
      status: 'redeeming',
      origin: transaction.origin,
      retainUntil: this.now() + this.ttl(),
    })
    return {
      ok: true,
      completed: {
        relay: transaction.relay,
        instanceKey: transaction.instanceKey,
        verifier: transaction.verifier,
      },
    }
  }

  /**
   * Record how one transaction ended.
   *
   * A transaction still awaiting its code settles only as a refusal: no code will complete it. A
   * redeeming one settles with its exchange's outcome. A settled or unknown one records nothing.
   * @param state - The transaction that ended.
   * @param settlement - The identity it stored, or the refusal its page states.
   */
  settle(state: string, settlement: OwnerLoginSettlement): void {
    const record = this.records.get(state)
    let origin: string
    if (record?.status === 'awaiting-code' && !settlement.ok) origin = record.transaction.origin
    else if (record?.status === 'redeeming') origin = record.origin
    else return
    this.records.set(state, { status: 'settled', origin, retainUntil: this.now() + this.ttl(), settlement })
  }

  /**
   * Read one transaction for the page that began it.
   * @param state - The transaction the page minted.
   * @param origin - The reading page's origin; only the origin the transaction bound may read it.
   * @returns The transaction's progress, or undefined when it is unknown, lapsed, or bound to another page.
   */
  read(state: string, origin: string): OwnerLoginView | undefined {
    this.sweep()
    const record = this.records.get(state)
    if (record === undefined) return undefined
    switch (record.status) {
      case 'awaiting-code':
        return record.transaction.origin === origin ? record : undefined
      case 'redeeming':
        return record.origin === origin ? { status: 'redeeming' } : undefined
      case 'settled':
        return record.origin === origin ? { status: 'settled', settlement: record.settlement } : undefined
      /* v8 ignore next 2 -- the union is closed; this guards a future member. */
      default:
        return assertNever(record)
    }
  }

  /**
   * Drop one transaction the page abandoned.
   *
   * A cancelled attempt leaves nothing to redeem: the verifier is gone, so a code the Relay issues for it
   * afterwards can no longer be exchanged.
   * @param state - The transaction the page reported as cancelled.
   * @returns True when this host still held that transaction.
   */
  cancel(state: string): boolean {
    return this.records.delete(state)
  }

  /** Drop lapsed transactions and settlements so a long-lived host keeps only what can still be read. */
  private sweep(): void {
    const now = this.now()
    for (const [id, record] of this.records) {
      const until = record.status === 'awaiting-code' ? record.transaction.expiresAt : record.retainUntil
      if (now >= until) this.records.delete(id)
    }
  }
}

/**
 * The URL a browser opens, on the Relay's own origin, to sign in and confirm this authorization.
 *
 * `mode=poll` asks the Relay to hold the code for this host to collect and to render a completion page
 * instead of redirecting, so the owner may open it in any browser.
 * @param input - Relay address, transaction values, and the page origin the transaction bound.
 * @returns The absolute authorization URL.
 */
export function ownerAuthorizeUrl(input: {
  readonly relay: string
  readonly state: string
  readonly challenge: string
  readonly instanceKey: string
  readonly origin: string
}): string {
  const url = new URL(`${input.relay}/__liveshare/owner-authorize`)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('instance', input.instanceKey)
  url.searchParams.set('origin', input.origin)
  url.searchParams.set('mode', 'poll')
  return url.href
}
