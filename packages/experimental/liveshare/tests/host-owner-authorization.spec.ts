/**
 * The host's half of one owner authorization: every binding the browser could alter is checked again
 * when the code comes back, and only a passing completion consumes the transaction.
 */

import { describe, expect, it, vi } from 'vitest'
import { OwnerAuthorizations, ownerAuthorizeUrl } from '../src/host/owner-authorization.ts'

const START = Date.parse('2026-10-23T00:00:00Z')

/** One store over a clock this spec controls. */
function store(ttlMs = 5 * 60 * 1000) {
  let now = START
  return {
    authorizations: new OwnerAuthorizations({ ttlMs, now: () => now }),
    advance: (ms: number) => { now += ms },
  }
}

/** The bindings one environment states when a completion arrives. */
const bound = { relay: 'https://relay.example', instanceKey: 'instance-one', origin: 'https://dsh.example.test' }

/** The Relay and instance in force when a collected code completes a transaction. */
const completion = { relay: bound.relay, instanceKey: bound.instanceKey }

describe('owner authorization transactions', () => {
  it('hands one completion the verifier and its bindings, and consumes the transaction', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)

    expect(transaction.relay).toBe(bound.relay)
    expect(transaction.instanceKey).toBe(bound.instanceKey)
    // The verifier stays in this process; only its S256 challenge is published.
    expect(transaction.verifier).not.toBe(transaction.challenge)
    expect(transaction.challenge).toMatch(/^[A-Za-z0-9_-]+$/u)

    expect(authorizations.complete({ state: transaction.state, ...completion })).toEqual({
      ok: true,
      completed: { relay: bound.relay, instanceKey: bound.instanceKey, verifier: transaction.verifier },
    })
    // A state is single-use: the same code cannot be redeemed twice.
    expect(authorizations.complete({ state: transaction.state, ...completion }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('refuses a state this host never began', () => {
    const { authorizations } = store()
    expect(authorizations.complete({ state: 'never-issued', ...completion }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('refuses a transaction that outlived its deadline, and forgets it', () => {
    const { authorizations, advance } = store(1_000)
    const transaction = authorizations.begin(bound)
    advance(1_001)

    expect(authorizations.complete({ state: transaction.state, ...completion })).toEqual({ ok: false, code: 'expired' })
    // The expired transaction is dropped, so a retry reads as one that never existed.
    expect(authorizations.complete({ state: transaction.state, ...completion }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('refuses a completion reported under another Relay address or host instance', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)

    expect(authorizations.complete({
      state: transaction.state, ...completion, relay: 'https://other-relay.example',
    })).toEqual({ ok: false, code: 'relay-changed' })
    expect(authorizations.complete({ state: transaction.state, ...completion, instanceKey: 'instance-two' }))
      .toEqual({ ok: false, code: 'instance-changed' })
    expect(authorizations.complete({ state: transaction.state, ...completion })).toMatchObject({ ok: true })
  })

  it('states the Relay entry the browser opens, with the challenge and every binding it carries', () => {
    expect(ownerAuthorizeUrl({
      relay: 'https://relay.example',
      state: 'state-one',
      challenge: 'challenge-one',
      instanceKey: 'instance-one',
      origin: 'https://dsh.example.test',
    })).toBe('https://relay.example/__liveshare/owner-authorize?state=state-one&code_challenge=challenge-one'
      + '&instance=instance-one&origin=https%3A%2F%2Fdsh.example.test&mode=poll')
  })

  it('gives a transaction the production lifetime and clock when the host passes neither', () => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    try {
      const authorizations = new OwnerAuthorizations()
      expect(authorizations.begin(bound).expiresAt).toBe(START + 5 * 60 * 1000)
      // The clock is read again for the next attempt rather than captured at construction.
      vi.setSystemTime(START + 1_000)
      expect(authorizations.begin(bound).expiresAt).toBe(START + 1_000 + 5 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a transaction the browser abandoned, and reports whether it still waited for it', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)

    expect(authorizations.cancel(transaction.state)).toBe(true)
    expect(authorizations.cancel(transaction.state)).toBe(false)
    expect(authorizations.complete({ state: transaction.state, ...completion }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('sweeps an expired attempt when the next one begins, and keeps a live one', () => {
    const { authorizations, advance } = store(1_000)
    const stale = authorizations.begin(bound)
    advance(600)
    const live = authorizations.begin(bound)
    advance(500)

    // Beginning the next attempt is what drops the deadline nobody came back for; the second
    // transaction is still within its own and must survive the sweep.
    const fresh = authorizations.begin(bound)

    expect(authorizations.complete({ state: stale.state, ...completion }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
    expect(authorizations.complete({ state: live.state, ...completion })).toMatchObject({ ok: true })
    expect(authorizations.complete({ state: fresh.state, ...completion })).toMatchObject({ ok: true })
  })
})

describe('owner authorization settlement', () => {
  const verified = { state: 'verified', relay: bound.relay } as const

  it('reports a transaction from awaiting its code through redeeming to its settlement', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)
    expect(authorizations.read(transaction.state, bound.origin)).toEqual({ status: 'awaiting-code', transaction })

    authorizations.complete({ state: transaction.state, ...completion })
    expect(authorizations.read(transaction.state, bound.origin)).toEqual({ status: 'redeeming' })

    authorizations.settle(transaction.state, { ok: true, identity: verified })
    expect(authorizations.read(transaction.state, bound.origin))
      .toEqual({ status: 'settled', settlement: { ok: true, identity: verified } })
    // A settlement is read, not consumed, and a later settlement does not replace it.
    authorizations.settle(transaction.state, { ok: false, error: 'owner-login-failed' })
    expect(authorizations.read(transaction.state, bound.origin))
      .toEqual({ status: 'settled', settlement: { ok: true, identity: verified } })
  })

  it('reads a transaction only for the page it was bound to, at every point of its life', () => {
    const { authorizations } = store()
    const other = 'https://other.example.test'
    const transaction = authorizations.begin(bound)
    expect(authorizations.read(transaction.state, other)).toBeUndefined()
    authorizations.complete({ state: transaction.state, ...completion })
    expect(authorizations.read(transaction.state, other)).toBeUndefined()
    authorizations.settle(transaction.state, { ok: true, identity: verified })
    expect(authorizations.read(transaction.state, other)).toBeUndefined()
    expect(authorizations.read('unknown', bound.origin)).toBeUndefined()
    // Settling a transaction this host never began records nothing.
    authorizations.settle('unknown', { ok: false, error: 'owner-login-failed' })
    expect(authorizations.read('unknown', bound.origin)).toBeUndefined()
  })

  it('settles a transaction still awaiting its code only as a refusal', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)
    authorizations.settle(transaction.state, { ok: true, identity: verified })
    expect(authorizations.read(transaction.state, bound.origin)).toMatchObject({ status: 'awaiting-code' })

    authorizations.settle(transaction.state, { ok: false, error: 'owner-login-expired' })
    expect(authorizations.read(transaction.state, bound.origin))
      .toEqual({ status: 'settled', settlement: { ok: false, error: 'owner-login-expired' } })
    // The refused transaction can no longer be completed.
    expect(authorizations.complete({ state: transaction.state, ...completion }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('drops a settlement on cancel or once one lifetime passed', () => {
    const { authorizations, advance } = store(1_000)
    const cancelled = authorizations.begin(bound)
    authorizations.complete({ state: cancelled.state, ...completion })
    expect(authorizations.cancel(cancelled.state)).toBe(true)
    expect(authorizations.read(cancelled.state, bound.origin)).toBeUndefined()

    const lapsed = authorizations.begin(bound)
    authorizations.complete({ state: lapsed.state, ...completion })
    authorizations.settle(lapsed.state, { ok: true, identity: verified })
    advance(999)
    expect(authorizations.read(lapsed.state, bound.origin)).toMatchObject({ status: 'settled' })
    advance(1)
    expect(authorizations.read(lapsed.state, bound.origin)).toBeUndefined()
  })
})
