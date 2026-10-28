// @vitest-environment jsdom
/** The owner's Relay sign-in: which message may hand this page a code, and what the page states. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginOwnerLogin, hostOwnerLogin, OWNER_LOGIN_ACK_TYPE, OWNER_LOGIN_CODE_TYPE, readOwnerLoginCode,
  readOwnerLoginFailure, type OwnerLoginHost, type OwnerLoginPage, type OwnerLoginPhase,
  type OwnerLoginResult, type OwnerLoginTicket,
} from '../src/client/owner-login.ts'
import type { OwnerIdentityStatus } from '../src/client/owner-identity.ts'

const ORIGIN = 'https://relay.example.test'
const PAGE_ORIGIN = 'https://dsh.example.test'
const OTHER_RELAY = 'https://other.example.test'
const TICKET: OwnerLoginTicket = {
  authorizeUrl: `${ORIGIN}/__liveshare/auth/start?state=s1`,
  state: 's1',
  messageOrigin: ORIGIN,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('owner login message', () => {
  const popup = {}
  const expected = { origin: ORIGIN, source: popup, state: 's1' }
  const message = (overrides: {
    readonly origin?: string
    readonly source?: unknown
    readonly data?: unknown
  } = {}) => ({
    origin: overrides.origin ?? ORIGIN,
    source: 'source' in overrides ? overrides.source : popup,
    data: 'data' in overrides
      ? overrides.data
      : { type: OWNER_LOGIN_CODE_TYPE, code: 'one-time-code', state: 's1' },
  })

  it('takes the code one popup hands back for this attempt', () => {
    expect(readOwnerLoginCode(message(), expected)).toEqual({ code: 'one-time-code', state: 's1' })
  })

  it('drops a message from another origin, window, state, or shape', () => {
    // Another page on another origin is not this attempt's sender, whatever it says.
    expect(readOwnerLoginCode(message({ origin: 'https://evil.example.test' }), expected)).toBeUndefined()
    // Nor is another window on the right origin.
    expect(readOwnerLoginCode(message({ source: {} }), expected)).toBeUndefined()
    expect(readOwnerLoginCode(message({ source: null }), expected)).toBeUndefined()
    // A code minted for another transaction (or a stale one from an earlier attempt) is not ours.
    expect(readOwnerLoginCode(message({ data: { type: OWNER_LOGIN_CODE_TYPE, code: 'c', state: 's2' } }), expected))
      .toBeUndefined()
    expect(readOwnerLoginCode(message({ data: { type: OWNER_LOGIN_CODE_TYPE, code: 'c', state: '' } }), expected))
      .toBeUndefined()
    // A message that is not even the shape this page posts on is dropped, not guessed at.
    expect(readOwnerLoginCode(message({ data: { type: 'liveshare-auth-ack', code: 'c', state: 's1' } }), expected))
      .toBeUndefined()
    expect(readOwnerLoginCode(message({ data: 'one-time-code' }), expected)).toBeUndefined()
    expect(readOwnerLoginCode(message({ data: null }), expected)).toBeUndefined()
    expect(readOwnerLoginCode(message({ data: { type: OWNER_LOGIN_CODE_TYPE, state: 's1' } }), expected))
      .toBeUndefined()
    expect(readOwnerLoginCode(message({ data: { type: OWNER_LOGIN_CODE_TYPE, code: '', state: 's1' } }), expected))
      .toBeUndefined()
  })

  it('never accepts an attempt the host bound to no origin or a wildcard', () => {
    expect(readOwnerLoginCode(message(), { ...expected, origin: '*' })).toBeUndefined()
    expect(readOwnerLoginCode(message(), { ...expected, origin: '' })).toBeUndefined()
    expect(readOwnerLoginCode(message(), { ...expected, source: null })).toBeUndefined()
  })

  it('states the reason a host named, and nothing for a code it does not know', () => {
    expect(readOwnerLoginFailure({ error: 'owner-login-cancelled' })).toBe('cancelled')
    expect(readOwnerLoginFailure({ error: 'owner-login-expired' })).toBe('expired')
    expect(readOwnerLoginFailure({ error: 'owner-login-mismatch' })).toBe('mismatch')
    expect(readOwnerLoginFailure({ error: 'owner-login-replayed' })).toBe('replayed')
    expect(readOwnerLoginFailure({ error: 'owner-login-unavailable' })).toBe('unavailable')
    expect(readOwnerLoginFailure({ error: 'owner-login-failed' })).toBe('failed')
    expect(readOwnerLoginFailure({ error: 'owner-login-newer-than-this-build' })).toBeUndefined()
    expect(readOwnerLoginFailure({ error: 42 })).toBeUndefined()
    expect(readOwnerLoginFailure(undefined)).toBeUndefined()
  })
})

describe('owner login host face', () => {
  /** Answer one host call with the given status and body. */
  function answering(status: number, body: unknown) {
    return vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(Response.json(body, { status })))
  }

  it('asks its own host for one transaction and reads the ticket it may open', async () => {
    const request = answering(200, {
      authorizeUrl: `${ORIGIN}/__liveshare/auth/start?state=s1`,
      state: 's1',
      messageOrigin: ORIGIN,
      expiresAt: '2026-09-13T00:00:00Z',
    })
    await expect(hostOwnerLogin(ORIGIN, request).start()).resolves.toEqual({
      ok: true,
      value: { ...TICKET, expiresAt: '2026-09-13T00:00:00Z' },
    })
    expect(request.mock.calls[0]?.[0]).toBe('api/liveshare.ownerLoginStart')
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' })
  })

  it('posts through this page\u2019s own fetch when the caller names none', async () => {
    const fetchDouble = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ error: 'owner-login-unavailable' }, { status: 503 })))
    vi.stubGlobal('fetch', fetchDouble)
    await expect(hostOwnerLogin(ORIGIN).start()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(fetchDouble).toHaveBeenCalledWith('api/liveshare.ownerLoginStart', expect.objectContaining({ method: 'POST' }))
  })

  it('reads a ticket without a stated deadline, and drops an address that is not a URL', async () => {
    await expect(hostOwnerLogin(ORIGIN, answering(200, {
      authorizeUrl: `${ORIGIN}/__liveshare/auth/start?state=s1`,
      state: 's1',
      messageOrigin: ORIGIN,
    })).start()).resolves.toEqual({ ok: true, value: TICKET })
    // An address that cannot be parsed is refused rather than handed to a window.
    await expect(hostOwnerLogin(ORIGIN, answering(200, {
      authorizeUrl: 'not a url',
      state: 's1',
      messageOrigin: ORIGIN,
    })).start()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('states an unnamed refusal as unavailable, and an unreadable body as no answer at all', async () => {
    await expect(hostOwnerLogin(ORIGIN, answering(503, {})).start())
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    // A body that is not JSON leaves nothing to read; the call still answers rather than throwing.
    const unreadable = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(new Response('not json', { status: 200 })))
    await expect(hostOwnerLogin(ORIGIN, unreadable).start())
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('refuses a ticket it must not use: no state, no address, or no sender origin', async () => {
    for (const body of [
      { authorizeUrl: `${ORIGIN}/auth`, messageOrigin: ORIGIN },
      { state: 's1', messageOrigin: ORIGIN },
      { authorizeUrl: `${ORIGIN}/auth`, state: 's1' },
      // The origin the host answered *this page* for is not a sender origin, so a ticket that names
      // only that cannot have any of its messages verified.
      { authorizeUrl: `${ORIGIN}/auth`, state: 's1', origin: PAGE_ORIGIN },
      { authorizeUrl: `${ORIGIN}/auth`, state: 's1', messageOrigin: '*' },
      { authorizeUrl: `${ORIGIN}/auth`, state: 's1', messageOrigin: '' },
      { authorizeUrl: 'javascript:alert(1)', state: 's1', messageOrigin: ORIGIN },
    ]) {
      await expect(hostOwnerLogin(ORIGIN, answering(200, body)).start())
        .resolves.toEqual({ ok: false, reason: 'unavailable' })
    }
    await expect(hostOwnerLogin(ORIGIN, answering(503, { error: 'owner-login-unavailable' })).start())
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(hostOwnerLogin(ORIGIN, vi.fn(() => Promise.reject(new Error('offline')))).start())
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('submits the code with its state, and reads the identity the host answers with', async () => {
    const request = answering(200, { state: 'verified', relay: ORIGIN, displayName: '许翰翔' })
    const redeemed = await hostOwnerLogin(ORIGIN, request).redeem('one-time-code', 's1')
    expect(redeemed).toEqual({
      ok: true,
      value: { state: 'verified', relay: ORIGIN, displayName: '许翰翔' },
    })
    const [path, init] = request.mock.calls[0] ?? []
    expect(path).toBe('api/liveshare.ownerLoginRedeem')
    expect(init?.body).toBe(JSON.stringify({ code: 'one-time-code', state: 's1' }))
    // The page never puts the code in an address, so nothing it hands the host can be replayed from
    // a URL, a referrer, or a log line.
    expect(path).not.toContain('one-time-code')
  })

  it('never calls a redemption done unless the host read a verified identity back for this Relay', async () => {
    // A 200 that leaves the owner unverified is not a sign-in this page may report as verified.
    await expect(hostOwnerLogin(ORIGIN, answering(200, { state: 'unverified', relay: ORIGIN }))
      .redeem('c', 's1')).resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(hostOwnerLogin(ORIGIN, answering(200, { state: 'expired', relay: ORIGIN }))
      .redeem('c', 's1')).resolves.toEqual({ ok: false, reason: 'failed' })
    // A verified identity another Relay issued belongs to that address, not to this attempt.
    await expect(hostOwnerLogin(ORIGIN, answering(200, { state: 'verified', relay: OTHER_RELAY }))
      .redeem('c', 's1')).resolves.toEqual({ ok: false, reason: 'mismatch' })
    // And an answer this page cannot read at all is a failure rather than a verified owner.
    await expect(hostOwnerLogin(ORIGIN, answering(200, 'not json')).redeem('c', 's1'))
      .resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('proves the Relay from what the host stated, never from the address this page asked for', async () => {
    // The binding is this attempt's own: a body that names no Relay, an empty one, or a type that is
    // not an address leaves nothing to prove the identity belongs here, so it is a failure rather
    // than an address quietly filled in from the request.
    for (const body of [
      { state: 'verified' },
      { state: 'verified', relay: '' },
      { state: 'verified', relay: 42 },
      { state: 'verified', relay: null },
    ]) {
      await expect(hostOwnerLogin(ORIGIN, answering(200, body)).redeem('c', 's1'))
        .resolves.toEqual({ ok: false, reason: 'failed' })
    }
  })

  it('states the reason a refused redemption named', async () => {
    await expect(hostOwnerLogin(ORIGIN, answering(409, { error: 'owner-login-replayed' })).redeem('c', 's1'))
      .resolves.toEqual({ ok: false, reason: 'replayed' })
    await expect(hostOwnerLogin(ORIGIN, answering(410, { error: 'owner-login-expired' })).redeem('c', 's1'))
      .resolves.toEqual({ ok: false, reason: 'expired' })
    await expect(hostOwnerLogin(ORIGIN, answering(500, {})).redeem('c', 's1'))
      .resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(hostOwnerLogin(ORIGIN, vi.fn(() => Promise.reject(new Error('offline')))).redeem('c', 's1'))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('cancels the transaction it started, and survives a host that cannot be reached', async () => {
    const request = answering(200, {})
    await hostOwnerLogin(ORIGIN, request).cancel('s1')
    expect(request.mock.calls[0]?.[0]).toBe('api/liveshare.ownerLoginCancel')
    expect(request.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ state: 's1' }))
    await expect(hostOwnerLogin(ORIGIN, vi.fn(() => Promise.reject(new Error('offline')))).cancel('s1'))
      .resolves.toBeUndefined()
  })
})

describe('owner login attempt', () => {
  /** One fake page: the window it reserves, the messages it receives, and the clock its deadline reads. */
  function bench(options: {
    readonly popup?: boolean
    readonly ticket?: OwnerLoginTicket | undefined
    readonly start?: () => Promise<OwnerLoginResult<OwnerLoginTicket>>
    readonly clock?: { at: number }
  } = {}) {
    const phases: OwnerLoginPhase[] = []
    const failures: (string | undefined)[] = []
    const posted: { readonly message: unknown; readonly origin: string }[] = []
    const opened: string[] = []
    const listeners = new Set<(event: MessageEvent) => void>()
    const intervals = new Set<() => void>()
    const popup = {
      closed: false,
      location: { href: '' },
      postMessage: (message: unknown, origin: string) => { posted.push({ message, origin }) },
      close: () => { popup.closed = true },
    }
    const page: OwnerLoginPage = {
      // The flow reserves the window inside the gesture, then navigates it once the ticket lands.
      open: (url) => {
        opened.push(url)
        return options.popup === false ? null : popup
      },
      addEventListener: (_type, listener) => { listeners.add(listener) },
      removeEventListener: (_type, listener) => { listeners.delete(listener) },
      setInterval: (handler) => { intervals.add(handler); return intervals.size },
      clearInterval: (id) => { void id; intervals.clear() },
    }
    const redeem = vi.fn<() => Promise<OwnerLoginResult<OwnerIdentityStatus>>>(async () => ({
      ok: true, value: { state: 'verified', relay: ORIGIN },
    }))
    const cancel = vi.fn(async () => {})
    const start = vi.fn(options.start ?? (async () => ({ ok: true as const, value: options.ticket ?? TICKET })))
    const host: OwnerLoginHost = {
      start,
      redeem,
      cancel,
    }
    const attempt = beginOwnerLogin({
      host,
      page,
      ...(options.clock === undefined ? {} : { now: () => options.clock?.at ?? 0 }),
      report: (phase, failure) => { phases.push(phase); failures.push(failure) },
    })
    /** Deliver one window message the way the browser would. */
    const deliver = (event: { origin: string; source: unknown; data: unknown }): void => {
      for (const listener of [...listeners]) listener(event as MessageEvent)
    }
    return { attempt, host, start, redeem, cancel, phases, failures, posted, opened, popup, page, deliver, intervals }
  }

  it('opens the ticket\u2019s sign-in, acknowledges the code, and reports what the host read back', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    // The window is reserved inside the gesture and navigated once the host named the sign-in.
    expect(b.opened).toEqual([''])
    expect(b.popup.location.href).toBe(TICKET.authorizeUrl)
    b.deliver({
      origin: ORIGIN,
      source: b.popup,
      data: { type: OWNER_LOGIN_CODE_TYPE, code: 'one-time-code', state: 's1' },
    })
    await vi.waitFor(() => { expect(b.redeem).toHaveBeenCalledWith('one-time-code', 's1') })
    // The sign-in page closes on this acknowledgement, and it is addressed to the origin the host
    // bound the transaction to rather than to everything.
    expect(b.posted).toEqual([{ message: { type: OWNER_LOGIN_ACK_TYPE, state: 's1' }, origin: ORIGIN }])
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('verified') })
    expect(b.failures.at(-1)).toBeUndefined()
    // A finished attempt has nothing left to cancel, and saying so changes nothing it already stated.
    b.attempt.cancel()
    expect(b.phases.at(-1)).toBe('verified')
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('ignores a code from another origin, another window, or another transaction', async () => {
    for (const event of [
      { origin: 'https://evil.example.test', source: 'popup', data: { type: OWNER_LOGIN_CODE_TYPE, code: 'c', state: 's1' } },
      { origin: ORIGIN, source: 'other', data: { type: OWNER_LOGIN_CODE_TYPE, code: 'c', state: 's1' } },
      { origin: ORIGIN, source: 'popup', data: { type: OWNER_LOGIN_CODE_TYPE, code: 'c', state: 'stale' } },
    ] as const) {
      const b = bench()
      await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
      b.deliver({
        ...event,
        source: event.source === 'popup' ? b.popup : {},
      })
      expect(b.redeem).not.toHaveBeenCalled()
      expect(b.phases.at(-1)).toBe('waiting')
      b.attempt.cancel()
    }
  })

  it('submits one code once, however many times a sender repeats it', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    const data = { type: OWNER_LOGIN_CODE_TYPE, code: 'one-time-code', state: 's1' }
    b.deliver({ origin: ORIGIN, source: b.popup, data })
    b.deliver({ origin: ORIGIN, source: b.popup, data })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('verified') })
    expect(b.redeem).toHaveBeenCalledTimes(1)
  })

  it('states a cancellation when the owner closes the sign-in window', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.popup.closed = true
    for (const handler of [...b.intervals]) handler()
    expect(b.phases.at(-1)).toBe('failed')
    expect(b.failures.at(-1)).toBe('cancelled')
    expect(b.redeem).not.toHaveBeenCalled()
    // A closed sign-in window leaves nothing redeemable: the transaction is dropped on the host.
    expect(b.cancel).toHaveBeenCalledWith('s1')
  })

  it('ends an attempt on the deadline the host set for its transaction', async () => {
    const clock = { at: 0 }
    const b = bench({
      clock,
      ticket: { ...TICKET, expiresAt: '2026-09-13T00:00:05Z' },
    })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    // A wrong state is not an expiry: the attempt keeps waiting while its transaction lives.
    b.deliver({
      origin: ORIGIN,
      source: b.popup,
      data: { type: OWNER_LOGIN_CODE_TYPE, code: 'c', state: 'stale' },
    })
    for (const handler of [...b.intervals]) handler()
    expect(b.phases.at(-1)).toBe('waiting')
    // The host's own deadline is what ends it, and the transaction is dropped rather than left.
    clock.at = Date.parse('2026-09-13T00:00:06Z')
    for (const handler of [...b.intervals]) handler()
    expect(b.phases.at(-1)).toBe('failed')
    expect(b.failures.at(-1)).toBe('expired')
    expect(b.redeem).not.toHaveBeenCalled()
    expect(b.cancel).toHaveBeenCalledWith('s1')
  })

  it('drops a ticket that arrives after the attempt was cancelled', async () => {
    let deliverTicket: ((result: OwnerLoginResult<OwnerLoginTicket>) => void) | undefined
    const b = bench({ start: () => new Promise((resolve) => { deliverTicket = resolve }) })
    expect(b.phases).toEqual(['opening'])
    b.attempt.cancel()
    expect(b.failures.at(-1)).toBe('cancelled')
    deliverTicket?.({ ok: true, value: TICKET })
    await vi.waitFor(() => { expect(b.cancel).toHaveBeenCalledWith('s1') })
    // Nothing was left redeemable, and this page never opened or submitted anything.
    expect(b.opened).toEqual([''])
    expect(b.redeem).not.toHaveBeenCalled()
  })

  it('states the reason a host refused the code with', async () => {
    const b = bench()
    b.redeem.mockResolvedValueOnce({ ok: false, reason: 'replayed' })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.deliver({
      origin: ORIGIN,
      source: b.popup,
      data: { type: OWNER_LOGIN_CODE_TYPE, code: 'one-time-code', state: 's1' },
    })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('replayed')
  })

  it('signs in on this page when the browser refuses a popup, and cancels what it started', async () => {
    const blocked = bench({ popup: false })
    // A refused popup is a named failure, not a silent navigation away from the code this page would
    // have to receive; nothing was started, so cancelling later changes nothing.
    expect(blocked.phases).toEqual(['failed'])
    expect(blocked.failures).toEqual(['blocked'])
    expect(blocked.start).not.toHaveBeenCalled()
    expect(blocked.redeem).not.toHaveBeenCalled()
    expect(blocked.cancel).not.toHaveBeenCalled()
    blocked.attempt.cancel()
    expect(blocked.phases).toEqual(['failed'])

    const b = bench()
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.attempt.cancel()
    expect(b.phases.at(-1)).toBe('failed')
    expect(b.failures.at(-1)).toBe('cancelled')
    expect(b.popup.closed).toBe(true)
    expect(b.cancel).toHaveBeenCalledWith('s1')
  })

  it('drops the transaction and closes the window when the reserved one cannot be navigated', async () => {
    const b = bench()
    // A window that refuses the sign-in address is a window no code can arrive in; unlike a window the
    // browser refused to open, this attempt already minted a transaction, so it is dropped here.
    Object.defineProperty(b.popup.location, 'href', {
      configurable: true,
      set() { throw new Error('navigation refused') },
    })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('blocked')
    expect(b.start).toHaveBeenCalledTimes(1)
    expect(b.redeem).not.toHaveBeenCalled()
    expect(b.cancel).toHaveBeenCalledWith('s1')
    expect(b.popup.closed).toBe(true)
  })

  it('closes the window and states why when the host refuses to mint a transaction', async () => {
    const b = bench({ start: async () => ({ ok: false, reason: 'unavailable' }) })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('unavailable')
    expect(b.popup.closed).toBe(true)
    // Nothing was minted, so there is nothing to drop on the host.
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('drops the ticket of a window that closed while the host was minting it', async () => {
    let minted: ((result: OwnerLoginResult<OwnerLoginTicket>) => void) | undefined
    const b = bench({ start: () => new Promise((resolve) => { minted = resolve }) })
    b.popup.closed = true
    minted?.({ ok: true, value: TICKET })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('cancelled')
    expect(b.cancel).toHaveBeenCalledWith('s1')
    // The window was gone before the sign-in could be navigated to, so nothing opened or submitted.
    expect(b.popup.location.href).toBe('')
    expect(b.redeem).not.toHaveBeenCalled()
  })

  it('reads its own clock for a deadline when the caller names none', async () => {
    const b = bench({ ticket: { ...TICKET, expiresAt: '2099-01-01T00:00:00Z' } })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    for (const handler of [...b.intervals]) handler()
    // A deadline in the future does not end the attempt, and the page's own clock said so.
    expect(b.phases.at(-1)).toBe('waiting')
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('ends one attempt once even when its timer fires again', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    const handler = [...b.intervals][0]
    if (handler === undefined) throw new Error('the attempt armed no timer')
    b.popup.closed = true
    handler()
    handler()
    expect(b.phases.filter(phase => phase === 'failed')).toHaveLength(1)
    // The timer drops the same transaction again before the finished attempt ignores it; both drops
    // name the one state, and the attempt itself reports once.
    expect(b.cancel).toHaveBeenCalledTimes(2)
  })

  it('never calls an identity the host did not verify a completed sign-in', async () => {
    const b = bench()
    b.redeem.mockResolvedValueOnce({ ok: true, value: { state: 'unverified', relay: ORIGIN } })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.deliver({
      origin: ORIGIN,
      source: b.popup,
      data: { type: OWNER_LOGIN_CODE_TYPE, code: 'one-time-code', state: 's1' },
    })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('failed')
  })
})
