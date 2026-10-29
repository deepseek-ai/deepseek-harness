/**
 * The host's half of one owner-authorization: a transaction the browser starts here, a single-use code the
 * Relay issues on its own origin, and the verifier only this host holds.
 *
 * The owner authorizes one DSH instance to be reported by one Relay address. The long-term credential
 * never travels through the browser: the Relay issues a code to the page it served, the page reports that
 * code back to the exact origin this transaction bound, and this host redeems it over TLS with the PKCE
 * verifier that never left the process. Every binding — Relay, instance, origin, state — is checked again
 * at redemption, and the transaction is consumed by exactly one completion.
 */

import { createHash, randomBytes } from 'node:crypto'

/** Why one owner-authorization attempt was refused. */
export type OwnerAuthorizationRefusal =
  /** No transaction has this id, or it was already completed. */
  | 'unknown-transaction'
  /** The transaction outlived its deadline. */
  | 'expired'
  /** The request did not come from the page that began the transaction. */
  | 'origin-mismatch'
  /** The address in force is not the one this transaction authorized. */
  | 'relay-changed'
  /** This host's instance is not the one the transaction was minted for. */
  | 'instance-changed'

/** One transaction the host began and is waiting to complete. */
export interface OwnerAuthorizationTransaction {
  /**
   * Single-use identifier the Relay echoes back through the browser.
   *
   * It is also the transaction's key, so the browser carries exactly one opaque value: the state the page
   * compares against, the value the Relay binds its code to, and the handle this host completes with.
   */
  readonly state: string
  /** PKCE verifier, held only by this host; the Relay is given its S256 challenge. */
  readonly verifier: string
  readonly challenge: string
  /** Relay address this transaction authorizes, normalized. */
  readonly relay: string
  /** Host instance the credential will be minted for. */
  readonly instanceKey: string
  /** Exact page origin allowed to report the code back. */
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

/** One authorization's lifetime; short because the owner completes it in the same browser session. */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** `base64url` without padding, the encoding PKCE specifies for both values. */
function base64url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * The transactions this host has begun and not yet completed.
 *
 * Held in memory and keyed by id: a restart invalidates pending authorizations, which the owner retries
 * from the browser rather than the host resurrecting one it can no longer vouch for.
 */
export class OwnerAuthorizations {
  private readonly pending = new Map<string, OwnerAuthorizationTransaction>()

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

  /**
   * Begin one authorization for a Relay address, a host instance, and the page that asked.
   *
   * The verifier stays here and only its S256 challenge is published, so a code intercepted in transit is
   * useless without this process.
   * @param input - Relay address, host instance, and the exact page origin that began it.
   * @returns The transaction, whose id and state the browser carries and whose challenge the Relay gets.
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
      expiresAt: this.now() + (this.options.ttlMs ?? DEFAULT_TTL_MS),
    }
    this.pending.set(transaction.state, transaction)
    return transaction
  }

  /**
   * Complete one authorization, checking every binding the browser could have altered.
   *
   * The transaction is consumed only by a completion that passes: a mismatched state, origin, relay, or
   * instance leaves it pending so the owner can retry the same attempt.
   * @param input - The state and code the page reported, the page's own origin, and the Relay address and
   *   host instance in force right now.
   * @returns The verifier with its bindings, or the stable code naming the refusal.
   */
  complete(input: {
    readonly state: string
    readonly origin: string | undefined
    readonly relay: string
    readonly instanceKey: string
  }): OwnerAuthorizationOutcome {
    const transaction = this.pending.get(input.state)
    if (transaction === undefined) return { ok: false, code: 'unknown-transaction' }
    if (this.now() >= transaction.expiresAt) {
      this.pending.delete(transaction.state)
      return { ok: false, code: 'expired' }
    }
    if (input.origin === undefined || input.origin !== transaction.origin) {
      return { ok: false, code: 'origin-mismatch' }
    }
    if (input.relay !== transaction.relay) return { ok: false, code: 'relay-changed' }
    if (input.instanceKey !== transaction.instanceKey) return { ok: false, code: 'instance-changed' }
    this.pending.delete(transaction.state)
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
   * Drop one pending authorization the browser abandoned.
   *
   * A cancelled attempt leaves no credential and nothing to redeem: the verifier is gone, so a code
   * minted for it afterwards can no longer be exchanged.
   * @param state - The transaction the page reported as cancelled.
   * @returns True when this host was still waiting for that transaction.
   */
  cancel(state: string): boolean {
    return this.pending.delete(state)
  }

  /** Drop expired transactions so a long-lived host keeps only what can still complete. */
  private sweep(): void {
    const now = this.now()
    for (const [id, transaction] of this.pending) {
      if (now >= transaction.expiresAt) this.pending.delete(id)
    }
  }
}

/**
 * The URL a browser opens, on the Relay's own origin, to sign in and then confirm this authorization.
 * @param input - Relay address, transaction values, and the page origin the Relay may report back to.
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
  return url.href
}
