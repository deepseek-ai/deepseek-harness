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

describe('owner authorization transactions', () => {
  it('hands one completion the verifier and its bindings, and consumes the transaction', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)

    expect(transaction.relay).toBe(bound.relay)
    expect(transaction.instanceKey).toBe(bound.instanceKey)
    // The verifier stays in this process; only its S256 challenge is published.
    expect(transaction.verifier).not.toBe(transaction.challenge)
    expect(transaction.challenge).toMatch(/^[A-Za-z0-9_-]+$/u)

    expect(authorizations.complete({ state: transaction.state, ...bound })).toEqual({
      ok: true,
      completed: { relay: bound.relay, instanceKey: bound.instanceKey, verifier: transaction.verifier },
    })
    // A state is single-use: the same code cannot be redeemed twice.
    expect(authorizations.complete({ state: transaction.state, ...bound }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('refuses a state this host never began', () => {
    const { authorizations } = store()
    expect(authorizations.complete({ state: 'never-issued', ...bound }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('refuses a transaction that outlived its deadline, and forgets it', () => {
    const { authorizations, advance } = store(1_000)
    const transaction = authorizations.begin(bound)
    advance(1_001)

    expect(authorizations.complete({ state: transaction.state, ...bound })).toEqual({ ok: false, code: 'expired' })
    // The expired transaction is dropped, so a retry reads as one that never existed.
    expect(authorizations.complete({ state: transaction.state, ...bound }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
  })

  it('refuses a completion from another origin, and keeps the attempt pending', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)

    expect(authorizations.complete({ state: transaction.state, ...bound, origin: 'https://elsewhere.test' }))
      .toEqual({ ok: false, code: 'origin-mismatch' })
    // The owner can retry the same attempt from the page that began it.
    expect(authorizations.complete({ state: transaction.state, ...bound })).toMatchObject({ ok: true })
  })

  it('refuses a completion reported under another Relay address or host instance', () => {
    const { authorizations } = store()
    const transaction = authorizations.begin(bound)

    expect(authorizations.complete({
      state: transaction.state, ...bound, relay: 'https://other-relay.example',
    })).toEqual({ ok: false, code: 'relay-changed' })
    expect(authorizations.complete({ state: transaction.state, ...bound, instanceKey: 'instance-two' }))
      .toEqual({ ok: false, code: 'instance-changed' })
    expect(authorizations.complete({ state: transaction.state, ...bound })).toMatchObject({ ok: true })
  })

  it('states the Relay entry the browser opens, with the challenge and every binding it carries', () => {
    expect(ownerAuthorizeUrl({
      relay: 'https://relay.example',
      state: 'state-one',
      challenge: 'challenge-one',
      instanceKey: 'instance-one',
      origin: 'https://dsh.example.test',
    })).toBe('https://relay.example/__liveshare/owner-authorize?state=state-one&code_challenge=challenge-one'
      + '&instance=instance-one&origin=https%3A%2F%2Fdsh.example.test')
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
    expect(authorizations.complete({ state: transaction.state, ...bound }))
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

    expect(authorizations.complete({ state: stale.state, ...bound }))
      .toEqual({ ok: false, code: 'unknown-transaction' })
    expect(authorizations.complete({ state: live.state, ...bound })).toMatchObject({ ok: true })
    expect(authorizations.complete({ state: fresh.state, ...bound })).toMatchObject({ ok: true })
  })
})
