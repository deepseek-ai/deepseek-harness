// @vitest-environment jsdom
/** The owner's Relay sign-in: what the page asks its host, what it opens, and what it states. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginOwnerLogin, hostOwnerLogin, readOwnerLoginFailure,
  type OwnerLoginHost, type OwnerLoginPage, type OwnerLoginPhase, type OwnerLoginResult,
  type OwnerLoginStatusResult, type OwnerLoginTicket,
} from '../src/client/owner-login.ts'

const ORIGIN = 'https://relay.example.test'
const OTHER_RELAY = 'https://other.example.test'
const TICKET: OwnerLoginTicket = {
  authorizeUrl: `${ORIGIN}/__liveshare/owner-authorize?state=s1&mode=poll`,
  state: 's1',
}
const VERIFIED: OwnerLoginStatusResult = { ok: true, value: { state: 'verified', relay: ORIGIN } }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('owner login failure codes', () => {
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
    return vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } },
    )))
  }

  it('asks its own host for one transaction and reads the ticket it may open', async () => {
    const request = answering(200, { ...TICKET, expiresAt: '2026-09-13T00:00:00Z' })
    await expect(hostOwnerLogin(ORIGIN, request).start()).resolves.toEqual({
      ok: true,
      value: { ...TICKET, expiresAt: '2026-09-13T00:00:00Z' },
    })
    expect(request.mock.calls[0]?.[0]).toBe('api/liveshare.ownerLoginStart')
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    // A ticket without a deadline is still a ticket.
    await expect(hostOwnerLogin(ORIGIN, answering(200, TICKET)).start()).resolves.toEqual({ ok: true, value: TICKET })
  })

  it('posts through this page\u2019s own fetch when the caller names none', async () => {
    const fetchDouble = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ error: 'owner-login-unavailable' }, { status: 503 })))
    vi.stubGlobal('fetch', fetchDouble)
    await expect(hostOwnerLogin(ORIGIN).start()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(fetchDouble).toHaveBeenCalledWith('api/liveshare.ownerLoginStart', expect.objectContaining({ method: 'POST' }))
  })

  it('refuses a ticket it must not use, and states an unnamed refusal as unavailable', async () => {
    for (const body of [
      { authorizeUrl: `${ORIGIN}/auth` },
      { state: 's1' },
      { authorizeUrl: 'not a url', state: 's1' },
      { authorizeUrl: 'javascript:alert(1)', state: 's1' },
    ]) {
      await expect(hostOwnerLogin(ORIGIN, answering(200, body)).start())
        .resolves.toEqual({ ok: false, reason: 'unavailable' })
    }
    await expect(hostOwnerLogin(ORIGIN, answering(503, {})).start()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(hostOwnerLogin(ORIGIN, answering(409, { error: 'owner-login-mismatch' })).start())
      .resolves.toEqual({ ok: false, reason: 'mismatch' })
    await expect(hostOwnerLogin(ORIGIN, answering(200, 'not json')).start())
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(hostOwnerLogin(ORIGIN, vi.fn(() => Promise.reject(new Error('offline')))).start())
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('asks its host for a transaction\u2019s settlement and states what it reports', async () => {
    const request = answering(200, { status: 'pending' })
    await expect(hostOwnerLogin(ORIGIN, request).status('s1')).resolves.toEqual({ ok: false, pending: true })
    expect(request.mock.calls[0]?.[0]).toBe('api/liveshare.ownerLoginStatus')
    expect(request.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ state: 's1' }))

    await expect(hostOwnerLogin(ORIGIN, answering(200, { status: 'verified', identity: { state: 'verified', relay: ORIGIN } })).status('s1'))
      .resolves.toEqual(VERIFIED)
    await expect(hostOwnerLogin(ORIGIN, answering(200, { status: 'failed', error: 'owner-login-expired' })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'expired' })
    await expect(hostOwnerLogin(ORIGIN, answering(200, { status: 'failed' })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(hostOwnerLogin(ORIGIN, answering(400, { error: 'invalid-status' })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(hostOwnerLogin(ORIGIN, answering(403, { error: 'owner-login-mismatch' })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'mismatch' })
  })

  it('keeps waiting when the host cannot be reached, and accepts only a verified identity at its Relay', async () => {
    await expect(hostOwnerLogin(ORIGIN, vi.fn(() => Promise.reject(new Error('offline')))).status('s1'))
      .resolves.toEqual({ ok: false, pending: true })
    // A verified identity another Relay issued belongs to that address, not to this attempt.
    await expect(hostOwnerLogin(ORIGIN, answering(200, { status: 'verified', identity: { state: 'verified', relay: OTHER_RELAY } })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'mismatch' })
    await expect(hostOwnerLogin(ORIGIN, answering(200, { status: 'verified' })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'mismatch' })
    await expect(hostOwnerLogin(ORIGIN, answering(200, { status: 'verified', identity: { state: 'unverified', relay: ORIGIN } })).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(hostOwnerLogin(ORIGIN, answering(200, 'not json')).status('s1'))
      .resolves.toEqual({ ok: false, reason: 'failed' })
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
  /** A status face whose answers this spec delivers by hand. */
  const heldStatus = () => {
    const pending: ((result: OwnerLoginStatusResult) => void)[] = []
    const status = vi.fn((_state: string) => new Promise<OwnerLoginStatusResult>((resolve) => { pending.push(resolve) }))
    return { status, answer: (result: OwnerLoginStatusResult) => { pending.shift()?.(result) } }
  }

  /** One fake page: the window it reserves, what it opens, and the timer it polls with. */
  function bench(options: {
    /** Leave the page without a reserved window, as the Desktop shell does. */
    readonly noWindow?: boolean
    readonly ticket?: OwnerLoginTicket
    readonly start?: () => Promise<OwnerLoginResult<OwnerLoginTicket>>
    readonly status?: (_state: string) => Promise<OwnerLoginStatusResult>
    readonly clock?: { at: number }
  } = {}) {
    const phases: OwnerLoginPhase[] = []
    const failures: (string | undefined)[] = []
    const links: (string | undefined)[] = []
    const opened: { readonly url: string; readonly name: string; readonly features: string | undefined }[] = []
    const intervals = new Set<() => void>()
    const reserved = {
      opener: {},
      closed: false,
      location: { href: '' },
      close: () => { reserved.closed = true },
    }
    const page: OwnerLoginPage = {
      open: (url, name, features) => {
        opened.push({ url, name, features })
        return options.noWindow === true ? null : reserved
      },
      setInterval: (handler) => { intervals.add(handler); return intervals.size },
      clearInterval: (id) => { void id; intervals.clear() },
    }
    const cancel = vi.fn(async () => {})
    const status = vi.fn(options.status ?? (async () => ({ ok: false as const, pending: true as const })))
    const start = vi.fn(options.start ?? (async () => ({ ok: true as const, value: options.ticket ?? TICKET })))
    const host: OwnerLoginHost = { start, status, cancel }
    const attempt = beginOwnerLogin({
      host,
      page,
      ...(options.clock === undefined ? {} : { now: () => options.clock?.at ?? 0 }),
      report: (phase, failure, link) => {
        phases.push(phase)
        failures.push(failure)
        links.push(link)
      },
    })
    /** Fire every armed timer once. */
    const tick = (): void => { for (const handler of [...intervals]) handler() }
    return { attempt, start, status, cancel, phases, failures, links, opened, reserved, intervals, tick }
  }

  it('navigates the window it reserved, offers the address, and waits for the host to settle', async () => {
    const held = heldStatus()
    const b = bench({ status: held.status })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    // The window is reserved inside the gesture and navigated once the host named the sign-in.
    expect(b.opened).toEqual([{ url: '', name: '_blank', features: undefined }])
    expect(b.reserved.location.href).toBe(TICKET.authorizeUrl)
    expect(b.reserved.opener).toBeNull()
    // The address is always offered: an open window is no proof a browser is on screen.
    expect(b.links.at(-1)).toBe(TICKET.authorizeUrl)

    b.tick()
    expect(held.status).toHaveBeenCalledWith('s1')
    held.answer({ ok: false, pending: true })
    await vi.waitFor(() => { b.tick(); expect(held.status).toHaveBeenCalledTimes(2) })
    expect(b.phases.at(-1)).toBe('waiting')
    held.answer(VERIFIED)
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('verified') })
    // A finished attempt has nothing left to cancel, and saying so changes nothing it already stated.
    b.attempt.cancel()
    expect(b.phases.at(-1)).toBe('verified')
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('opens the address directly for a page that got no window', async () => {
    // The Desktop shell denies this page a window and opens the address in the system browser instead.
    const b = bench({ noWindow: true })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    expect(b.opened).toEqual([
      { url: '', name: '_blank', features: undefined },
      { url: TICKET.authorizeUrl, name: '_blank', features: 'noopener' },
    ])
    expect(b.links.at(-1)).toBe(TICKET.authorizeUrl)
  })

  it('keeps waiting with the address when the reserved window refuses it', async () => {
    const b = bench()
    Object.defineProperty(b.reserved.location, 'href', {
      set: () => { throw new Error('the window refused the address') },
      get: () => '',
    })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    expect(b.links.at(-1)).toBe(TICKET.authorizeUrl)
    expect(b.reserved.closed).toBe(true)
  })

  it('asks once at a time, however many ticks pass while the host collects', async () => {
    const held = heldStatus()
    const b = bench({ status: held.status })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.tick()
    b.tick()
    b.tick()
    // A collection can outlast one tick; an overlapping ask would race it on the host.
    expect(held.status).toHaveBeenCalledTimes(1)
    held.answer({ ok: false, pending: true })
    await vi.waitFor(() => { b.tick(); expect(held.status).toHaveBeenCalledTimes(2) })
  })

  it('states the reason the host settled a refused sign-in with, and drops the transaction', async () => {
    const b = bench({ status: async () => ({ ok: false, reason: 'replayed' }) })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.tick()
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('replayed')
    expect(b.cancel).toHaveBeenCalledWith('s1')
  })

  it('ends the attempt on the transaction deadline, once, and drops what it started', async () => {
    const clock = { at: Date.parse('2026-09-13T00:00:01Z') }
    const b = bench({ ticket: { ...TICKET, expiresAt: '2026-09-13T00:00:05Z' }, clock })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    clock.at = Date.parse('2026-09-13T00:00:06Z')
    const handler = [...b.intervals][0]
    if (handler === undefined) throw new Error('the attempt armed no timer')
    handler()
    handler()
    expect(b.phases.filter(phase => phase === 'failed')).toHaveLength(1)
    expect(b.failures.at(-1)).toBe('expired')
    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.status).not.toHaveBeenCalled()
  })

  it('reads its own clock for a deadline when the caller names none', async () => {
    const b = bench({ ticket: { ...TICKET, expiresAt: '2099-01-01T00:00:00Z' } })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    b.tick()
    // A deadline in the future does not end the attempt, and the page's own clock said so.
    expect(b.phases.at(-1)).toBe('waiting')
    expect(b.status).toHaveBeenCalledOnce()
  })

  it('closes its window and states nothing after cancel, even for an answer already on its way', async () => {
    const held = heldStatus()
    const b = bench({ status: held.status })
    await vi.waitFor(() => { expect(b.phases).toContain('waiting') })
    const handlers = [...b.intervals]
    handlers[0]?.()
    b.attempt.cancel()
    expect(b.phases.at(-1)).toBe('failed')
    expect(b.failures.at(-1)).toBe('cancelled')
    expect(b.reserved.closed).toBe(true)
    expect(b.cancel).toHaveBeenCalledWith('s1')
    held.answer(VERIFIED)
    await Promise.resolve()
    // A tick already queued when the attempt stopped must not ask or state anything after the cancel.
    for (const handler of handlers) handler()
    expect(held.status).toHaveBeenCalledTimes(1)
    expect(b.phases.at(-1)).toBe('failed')
  })

  it('cancels an attempt that has no window to close, and one whose window is already gone', async () => {
    const windowless = bench({ noWindow: true })
    await vi.waitFor(() => { expect(windowless.phases).toContain('waiting') })
    windowless.attempt.cancel()
    expect(windowless.failures.at(-1)).toBe('cancelled')
    expect(windowless.cancel).toHaveBeenCalledWith('s1')

    const gone = bench()
    gone.reserved.close = () => { throw new Error('the window is gone') }
    await vi.waitFor(() => { expect(gone.phases).toContain('waiting') })
    gone.attempt.cancel()
    expect(gone.failures.at(-1)).toBe('cancelled')
  })

  it('drops a ticket that arrives after the attempt was cancelled', async () => {
    let deliverTicket: ((result: OwnerLoginResult<OwnerLoginTicket>) => void) | undefined
    const b = bench({ start: () => new Promise((resolve) => { deliverTicket = resolve }) })
    expect(b.phases).toEqual(['opening'])
    b.attempt.cancel()
    expect(b.failures.at(-1)).toBe('cancelled')
    deliverTicket?.({ ok: true, value: TICKET })
    await vi.waitFor(() => { expect(b.cancel).toHaveBeenCalledWith('s1') })
    // Nothing was left redeemable, and this page never navigated anywhere.
    expect(b.reserved.location.href).toBe('')
  })

  it('states nothing more when the host refuses a transaction the owner already cancelled', async () => {
    let refuse: ((result: OwnerLoginResult<OwnerLoginTicket>) => void) | undefined
    const b = bench({ start: () => new Promise((resolve) => { refuse = resolve }) })
    b.attempt.cancel()
    refuse?.({ ok: false, reason: 'unavailable' })
    await Promise.resolve()
    expect(b.phases).toEqual(['opening', 'failed'])
    expect(b.failures).toEqual([undefined, 'cancelled'])
  })

  it('closes the window and states why when the host refuses to mint a transaction', async () => {
    const b = bench({ start: async () => ({ ok: false, reason: 'unavailable' }) })
    await vi.waitFor(() => { expect(b.phases.at(-1)).toBe('failed') })
    expect(b.failures.at(-1)).toBe('unavailable')
    expect(b.reserved.closed).toBe(true)
    // Nothing was minted, so there is nothing to drop on the host.
    expect(b.cancel).not.toHaveBeenCalled()
  })
})
