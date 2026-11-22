// @vitest-environment jsdom
/** Anonymous recovery keeps one Host request through transport failures and replaces it only after cancellation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PairingCredential, PairingTicket } from '../src/pairing-types.ts'
import { PairingRequests } from '../src/pairing-requests.ts'
import { mountPairing, type PairingRecovery } from '../src/anonymous/pairing.ts'
import { pairingLocales, pairingMethodLabels } from '../src/anonymous/locales.ts'

const recovery: PairingRecovery = {
  requestTtlMs: 30_000, pollIntervalMs: 1000, requestTimeoutMs: 500, maxRetries: 2, retryMaxDelayMs: 2000,
}
let dispose: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  document.head.innerHTML = '<base href="https://host.example/tools/dsh/">'
  document.body.innerHTML = '<div id="pairing-method"></div>'
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

function payload(init: RequestInit | undefined): PairingCredential {
  if (typeof init?.body !== 'string') throw new Error('Missing private request credential')
  return JSON.parse(init.body) as PairingCredential
}
function url(input: Parameters<typeof fetch>[0] | undefined): string {
  if (input === undefined) throw new Error('Missing request URL')
  return input instanceof Request ? input.url : input.toString()
}
function fixture(language = 'zh', overrides: Partial<PairingRecovery> = {}) {
  const policy = { ...recovery, ...overrides }
  const pool = new PairingRequests({ ...policy, maxRequests: 32, requestIntervalMs: 1 })
  let last: PairingTicket | undefined
  let loggedIn = false
  const issue = vi.fn(() => 'cookie')
  const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (init?.method === 'HEAD') return new Response(null, { status: loggedIn ? 200 : 401 })
    const held = payload(init)
    if (url(input).endsWith('/request')) {
      const ticket = pool.create('https://host.example', '192.0.2.17', held)
      if (ticket === undefined) return new Response('{"status":"busy"}', { status: 429 })
      last = ticket
      return new Response(JSON.stringify(ticket))
    }
    const result = pool.poll(held.id, held.secret, 'https://host.example', url(input).endsWith('/cancel'), issue)
    if (result.status === 'completed') loggedIn = true
    return new Response(JSON.stringify(result), { status: result.status === 'slow-down' ? 429 : 200 })
  })
  const navigate = vi.fn<(value: string) => void>()
  const method = document.querySelector<HTMLElement>('#pairing-method')!
  dispose = mountPairing(method, {}, language === 'zh' ? pairingLocales.zh : pairingLocales.en,
    pairingMethodLabels[language] ?? pairingMethodLabels.en, { request, navigate }, policy)
  return {
    request, navigate, pool, issue,
    ticket() { if (last === undefined) throw new Error('No ticket received'); return last },
    approve() { if (last === undefined) throw new Error('No ticket received'); pool.decide(last.id, 'allow') },
  }
}
function button(id: string): HTMLButtonElement {
  const result = document.getElementById(`auth-pair-${id}`)
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing ${id} button`)
  return result
}
function state(): string | undefined { return document.getElementById('auth-pair-panel')?.dataset.state }
async function create(): Promise<void> { button('request').click(); await vi.advanceTimersByTimeAsync(0) }

it('keeps credentials out of the DOM, polls the mounted application, and signs in automatically', async () => {
  const f = fixture()
  await create()
  const ticket = f.ticket()
  expect(ticket.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  expect(ticket.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  expect(document.body.innerHTML).not.toContain(ticket.secret)
  expect(document.getElementById('auth-pair-retry')).toBeNull()
  expect(button('request').textContent).toBe('重新申请')
  expect(button('request').disabled).toBe(false)
  expect(url(f.request.mock.calls[0]?.[0])).toBe('https://host.example/tools/dsh/pairing/request')
  f.approve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ id: ticket.id, secret: ticket.secret }),
  })
  expect(f.issue).toHaveBeenCalledOnce()
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith('https://host.example/tools/dsh/')
  expect(vi.getTimerCount()).toBe(0)
})

it('retries a lost creation response with the same credentials without duplicating the Host request', async () => {
  const f = fixture()
  const normal = f.request.getMockImplementation()!
  f.request.mockImplementationOnce(async (...args) => { await normal(...args); throw new Error('response lost') })
  await create()
  const original = f.ticket()
  expect(f.pool.list()).toHaveLength(1)
  expect(state()).toBe('creating')
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request.mock.calls[1]?.[1]?.body).toBe(f.request.mock.calls[0]?.[1]?.body)
  expect(f.ticket().id).toBe(original.id)
  expect(f.ticket().expiresInMs).toBe(29_000)
  expect(f.pool.list()).toHaveLength(1)
  expect(state()).toBe('waiting')
})

it.each(['zh', 'en'] as const)('shows rate limiting during creation and status recovery with the same credentials in %s', async (language) => {
  const f = fixture(language)
  const locale = pairingLocales[language]
  f.request.mockResolvedValueOnce(new Response('{"status":"busy"}', { status: 429 }))
  await create()
  const held = payload(f.request.mock.calls[0]?.[1])
  expect(state()).toBe('creating')
  expect(document.querySelector('[role="status"]')?.textContent).toBe(locale.pairRateLimited)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(document.body.innerHTML).not.toContain(held.secret)
  expect(button('request').disabled).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(payload(f.request.mock.calls[1]?.[1])).toEqual(held)
  expect(f.pool.list()).toHaveLength(1)
  expect(state()).toBe('waiting')
  expect(document.querySelector('[role="status"]')?.textContent).toBe(locale.pairWaiting)

  f.request.mockResolvedValueOnce(new Response('{"status":"slow-down"}', { status: 429 }))
  await vi.advanceTimersByTimeAsync(1000)
  expect(document.querySelector('[role="status"]')?.textContent).toBe(locale.pairRateLimited)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request.mock.calls.slice(2).map(([, init]) => payload(init))).toEqual([held, held])
  expect(document.body.innerHTML).not.toContain(held.secret)
  expect(state()).toBe('waiting')
  expect(document.querySelector('[role="status"]')?.textContent).toBe(locale.pairWaiting)
  f.approve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.navigate).toHaveBeenCalledOnce()
})

it.each([
  ['zh', 'request', 2], ['en', 'status', 0],
] as const)('offers Request again when rate limits exhaust %s %s recovery with %s retries', async (language, operation, maxRetries) => {
  const f = fixture(language, { maxRetries })
  if (operation === 'status') await create()
  const before = f.request.mock.calls.length
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    f.request.mockResolvedValueOnce(new Response('{"status":"busy"}', { status: 429 }))
  }
  if (operation === 'request') await create()
  else await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(3000)
  const attempts = f.request.mock.calls.slice(before)
  const held = payload(attempts[0]?.[1])
  expect(attempts).toHaveLength(maxRetries + 1)
  expect(attempts.map(([, init]) => payload(init))).toEqual(Array.from({ length: maxRetries + 1 }, () => held))
  expect(state()).toBe('error')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(pairingLocales[language].pairRateLimitError)
  expect(document.body.innerHTML).not.toContain(held.secret)
  expect(button('request').disabled).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  await create()
  await vi.advanceTimersByTimeAsync(1000)
  const cancellation = f.request.mock.calls.find(([input]) => url(input).endsWith('/cancel'))
  expect(payload(cancellation?.[1])).toEqual(held)
  expect(f.pool.decide(held.id, 'allow')).toBe('unavailable')
  expect(f.ticket().id).not.toBe(held.id)
  expect(f.pool.list().map(row => row.id)).toEqual([f.ticket().id])
  expect(state()).toBe('waiting')
})

it.each(['zh', 'en'])('automatically backs off status failures and exposes only Request again after exhaustion in %s', async (language) => {
  const f = fixture(language)
  await create()
  const original = f.ticket()
  f.request.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response('{"status":"unavailable"}', { status: 503 }))
    .mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await vi.advanceTimersByTimeAsync(999)
  expect(f.request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1999)
  expect(f.request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(state()).toBe('error')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(language === 'zh' ? pairingLocales.zh.pairError : pairingLocales.en.pairError)
  expect(button('request').disabled).toBe(false)
  expect(document.getElementById('auth-pair-retry')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  await create()
  expect(f.pool.decide(original.id, 'allow')).toBe('unavailable')
  expect(f.ticket().id).not.toBe(original.id)
  expect(f.pool.list().map(row => row.id)).toEqual([f.ticket().id])
  expect(state()).toBe('waiting')
})

it.each(['headers', 'body'] as const)('times out stalled response %s and ignores its late completion after a successful retry', async (part) => {
  const f = fixture()
  await create()
  const heldResponse = Promise.withResolvers<Response>()
  const heldBody = Promise.withResolvers<unknown>()
  const response = new Response('{"status":"completed"}')
  if (part === 'body') vi.spyOn(response, 'json').mockReturnValue(heldBody.promise)
  f.request.mockReturnValueOnce(part === 'headers' ? heldResponse.promise : Promise.resolve(response))
  await vi.advanceTimersByTimeAsync(1000)
  const signal = f.request.mock.calls[1]?.[1]?.signal
  await vi.advanceTimersByTimeAsync(499)
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(signal?.aborted).toBe(true)
  f.approve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.navigate).toHaveBeenCalledOnce()
  heldResponse.resolve(response)
  heldBody.resolve({ status: 'completed' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).toHaveBeenCalledOnce()
  expect(f.issue).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('can replace while the old status request is in flight without accepting its late result', async () => {
  const f = fixture()
  await create()
  const original = f.ticket()
  const old = Promise.withResolvers<Response>()
  f.request.mockReturnValueOnce(old.promise)
  await vi.advanceTimersByTimeAsync(1000)
  const oldSignal = f.request.mock.calls[1]?.[1]?.signal
  expect(button('request').disabled).toBe(false)
  await create()
  const replacement = f.ticket()
  expect(oldSignal?.aborted).toBe(true)
  expect(replacement.id).not.toBe(original.id)
  expect(f.pool.decide(original.id, 'allow')).toBe('unavailable')
  expect(f.pool.list().map(row => row.id)).toEqual([replacement.id])
  old.resolve(new Response('{"status":"completed"}'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).not.toHaveBeenCalled()
  f.approve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.navigate).toHaveBeenCalledOnce()
})

it('recovers a creation identity before cancelling it and starting a different request', async () => {
  const f = fixture()
  const normal = f.request.getMockImplementation()!
  const old = Promise.withResolvers<Response>()
  let original: Response | undefined
  f.request.mockImplementationOnce(async (...args) => { original = await normal(...args); return old.promise })
  await create()
  const first = f.ticket()
  const oldSignal = f.request.mock.calls[0]?.[1]?.signal
  button('cancel').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(oldSignal?.aborted).toBe(true)
  expect(f.request.mock.calls[1]?.[1]?.body).toBe(f.request.mock.calls[0]?.[1]?.body)
  expect(f.pool.list()).toEqual([])
  expect(state()).toBe('cancelled')
  await vi.advanceTimersByTimeAsync(1)
  await create()
  expect(f.ticket().id).not.toBe(first.id)
  old.resolve(original!)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.pool.list().map(row => row.id)).toEqual([f.ticket().id])
  expect(f.navigate).not.toHaveBeenCalled()
  expect(state()).toBe('waiting')
})

it('does not create a replacement when cancellation remains unknown after retries', async () => {
  const f = fixture()
  await create()
  const first = f.ticket()
  f.request.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
  await create()
  await vi.advanceTimersByTimeAsync(3000)
  expect(state()).toBe('error')
  expect(f.request.mock.calls.filter(([input]) => url(input).endsWith('/request'))).toHaveLength(1)
  expect(f.pool.list().map(row => row.id)).toEqual([first.id])
  await create()
  expect(f.pool.decide(first.id, 'allow')).toBe('unavailable')
  expect(f.ticket().id).not.toBe(first.id)
  expect(f.pool.list()).toHaveLength(1)
})

it('collects a completed old request instead of creating another when cancellation races delivery', async () => {
  const f = fixture()
  await create()
  f.approve()
  const normal = f.request.getMockImplementation()!
  const body = Promise.withResolvers<unknown>()
  f.request.mockImplementationOnce(async (...args) => {
    const response = await normal(...args)
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    return response
  })
  await vi.advanceTimersByTimeAsync(1000)
  await create()
  expect(f.navigate).toHaveBeenCalledOnce()
  expect(f.issue).toHaveBeenCalledOnce()
  expect(f.request.mock.calls.filter(([input]) => url(input).endsWith('/request'))).toHaveLength(1)
  body.resolve({ status: 'completed' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).toHaveBeenCalledOnce()
})

it.each([200, 401])('automatically checks browser authorization at expiry and handles HTTP %s', async (status) => {
  const f = fixture('zh', { requestTtlMs: 2000 })
  await create()
  f.request.mockResolvedValueOnce(new Response('{"status":"pending"}'))
    .mockResolvedValueOnce(new Response(null, { status }))
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.request.mock.calls[2]?.[1]).toMatchObject({ method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  expect(f.navigate).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
  if (status === 401) expect(state()).toBe('expired')
  expect(vi.getTimerCount()).toBe(0)
})

it('retries a hung authorization check automatically and preserves the ticket when the retry budget is exhausted', async () => {
  const f = fixture('zh', { requestTtlMs: 2000 })
  await create()
  const held = Promise.withResolvers<Response>()
  f.request.mockResolvedValueOnce(new Response('{"status":"pending"}')).mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce(new Response(null, { status: 503 })).mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(5500)
  expect(state()).toBe('error')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(pairingLocales.zh.pairCheckError)
  expect(button('request').disabled).toBe(false)
  expect(f.request.mock.calls.filter(([input]) => url(input).endsWith('/request'))).toHaveLength(1)
  await create()
  expect(f.request.mock.calls.at(-3)?.[1]?.method).toBe('HEAD')
  expect(state()).toBe('waiting')
  expect(f.request.mock.calls.filter(([input]) => url(input).endsWith('/request'))).toHaveLength(2)
  held.resolve(new Response(null, { status: 200 }))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).not.toHaveBeenCalled()
})

it('checks a delivered Cookie when a completed response body crosses the local deadline', async () => {
  const f = fixture('zh', { requestTtlMs: 2000, requestTimeoutMs: 5000 })
  await create()
  f.approve()
  const normal = f.request.getMockImplementation()!
  const body = Promise.withResolvers<unknown>()
  f.request.mockImplementationOnce(async (...args) => {
    const response = await normal(...args)
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    return response
  })
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.navigate).toHaveBeenCalledOnce()
  body.resolve({ status: 'completed' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).toHaveBeenCalledOnce()
  expect(f.issue).toHaveBeenCalledOnce()
})

it('checks authorization after Host-reported expiry rather than creating a request immediately', async () => {
  const f = fixture()
  await create()
  f.request.mockResolvedValueOnce(new Response('{"status":"expired"}'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request.mock.calls[2]?.[1]?.method).toBe('HEAD')
  expect(state()).toBe('expired')
  expect(f.request).toHaveBeenCalledTimes(4)
})

it.each(['denied', 'cancelled'])('ends waiting on %s and permits a new approval flow', async (status) => {
  const f = fixture()
  await create()
  f.request.mockResolvedValueOnce(new Response(JSON.stringify({ status })))
  await vi.advanceTimersByTimeAsync(1000)
  expect(state()).toBe(status)
  expect(vi.getTimerCount()).toBe(0)
  await create()
  expect(state()).toBe('waiting')
})

it.each([
  ['request', '{"status":"forbidden"}'], ['request', 'Forbidden'],
  ['status', 'Forbidden'], ['cancel', 'Forbidden'],
] as const)('does not retry a permanent %s refusal with body %s', async (operation, body) => {
  const f = fixture()
  if (operation !== 'request') await create()
  const before = f.request.mock.calls.length
  const response = new Response(body, { status: 403 })
  const json = vi.spyOn(response, 'json')
  f.request.mockResolvedValueOnce(response)
  if (operation === 'status') await vi.advanceTimersByTimeAsync(1000)
  else if (operation === 'cancel') { button('cancel').click(); await vi.advanceTimersByTimeAsync(0) }
  else await create()
  expect(state()).toBe('error')
  expect(f.request).toHaveBeenCalledTimes(before + 1)
  expect(f.request.mock.calls[before]?.[1]?.signal?.aborted).toBe(true)
  expect(json).not.toHaveBeenCalled()
  expect(f.navigate).not.toHaveBeenCalled()
  expect(f.issue).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['request', 'status', 'cancel'] as const)('does not accept invalid JSON from a successful %s response', async (operation) => {
  const f = fixture()
  if (operation !== 'request') await create()
  const before = f.request.mock.calls.length
  f.request.mockImplementation(async () => new Response('not JSON'))
  if (operation === 'status') await vi.advanceTimersByTimeAsync(1000)
  else if (operation === 'cancel') { button('cancel').click(); await vi.advanceTimersByTimeAsync(0) }
  else await create()
  await vi.advanceTimersByTimeAsync(3000)
  expect(state()).toBe('error')
  expect(f.request).toHaveBeenCalledTimes(before + 3)
  expect(f.navigate).not.toHaveBeenCalled()
  expect(f.issue).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('caps retry delays and restarts the budget after a successful pending response', async () => {
  const f = fixture('zh', { maxRetries: 4, retryMaxDelayMs: 1500 })
  await create()
  f.request.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('{"status":"pending"}'))
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.request).toHaveBeenCalledTimes(5)
  f.request.mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request).toHaveBeenCalledTimes(6)
  f.approve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.navigate).toHaveBeenCalledOnce()
})

it.each(['delay', 'request'] as const)('cancels all work on disposal during a retry %s', async (phase) => {
  const f = fixture()
  const held = Promise.withResolvers<Response>()
  if (phase === 'request') f.request.mockReturnValueOnce(held.promise)
  else f.request.mockRejectedValueOnce(new Error('offline'))
  await create()
  const signal = f.request.mock.calls[0]?.[1]?.signal
  dispose?.()
  dispose = undefined
  if (phase === 'request') expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  held.resolve(new Response('{}'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.request).toHaveBeenCalledOnce()
  expect(f.navigate).not.toHaveBeenCalled()
})

it('resumes an interrupted creation with its original identity after BFCache suspension', async () => {
  const f = fixture()
  const normal = f.request.getMockImplementation()!
  const held = Promise.withResolvers<Response>()
  let original: Response | undefined
  f.request.mockImplementationOnce(async (...args) => { original = await normal(...args); return held.promise })
  await create()
  window.dispatchEvent(new Event('pagehide'))
  expect(vi.getTimerCount()).toBe(0)
  window.dispatchEvent(new Event('pageshow'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.request.mock.calls[1]?.[1]?.body).toBe(f.request.mock.calls[0]?.[1]?.body)
  expect(f.pool.list()).toHaveLength(1)
  held.resolve(original!)
  await vi.advanceTimersByTimeAsync(0)
  expect(state()).toBe('waiting')
})

it.each([
  ['id', 'wrong'], ['secret', 'wrong'], ['code', 'bad'], ['authority', ''], ['sourceIp', 1],
  ['expiresInMs', 0], ['expiresInMs', 0.5], ['pollIntervalMs', 0], ['pollIntervalMs', 1.5],
] as const)('rejects a malformed creation field %s=%s without polling', async (field, value) => {
  const f = fixture()
  const normal = f.request.getMockImplementation()!
  f.request.mockImplementationOnce(async (...args) => {
    const response = await normal(...args)
    return new Response(JSON.stringify({ ...await response.json(), [field]: value }))
  })
  await create()
  expect(state()).toBe('error')
  expect(vi.getTimerCount()).toBe(0)
  expect(f.navigate).not.toHaveBeenCalled()
})

it('waits for an attached browsing context before mounting', () => {
  const detached = document.implementation.createHTMLDocument('Detached')
  const method = detached.createElement('div')
  const release = mountPairing(method, {}, pairingLocales.en, pairingMethodLabels.en,
    { request: vi.fn<typeof fetch>(), navigate: vi.fn() }, recovery)
  release()
  expect(method.childNodes).toHaveLength(0)
})

it.each([null, 'invalid'])('rejects a non-object creation response: %s', async (value) => {
  const f = fixture()
  f.request.mockResolvedValueOnce(new Response(JSON.stringify(value)))
  await create()
  expect(state()).toBe('error')
  expect(f.request).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels a Host request that outlives the local countdown because creation arrived later', async () => {
  const f = fixture('zh', { requestTtlMs: 2000 })
  const normal = f.request.getMockImplementation()!
  const received = Promise.withResolvers<undefined>()
  f.request.mockImplementationOnce(async (...args) => { await received.promise; return normal(...args) })
  await create()
  await vi.advanceTimersByTimeAsync(100)
  received.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  const first = f.ticket()
  await vi.advanceTimersByTimeAsync(1900)
  expect(state()).toBe('expired')
  expect(f.pool.decide(first.id, 'allow')).toBe('unavailable')
  expect(f.pool.list()).toEqual([])
  expect(url(f.request.mock.calls.at(-1)?.[0])).toMatch(/\/pairing\/cancel$/u)
  await create()
  expect(f.pool.list().map(row => row.id)).toEqual([f.ticket().id])
})

it.each(['replace', 'cancel'] as const)('settles an interrupted %s at the deadline before another request can start', async (action) => {
  const f = fixture('zh', { requestTtlMs: 2000, requestTimeoutMs: 5000 })
  await create()
  const old = Promise.withResolvers<Response>()
  f.request.mockResolvedValueOnce(new Response('{"status":"pending"}'))
  await vi.advanceTimersByTimeAsync(1000)
  f.request.mockReturnValueOnce(old.promise)
  if (action === 'replace') await create()
  else { button('cancel').click(); await vi.advanceTimersByTimeAsync(0) }
  await vi.advanceTimersByTimeAsync(1000)
  expect(state()).toBe(action === 'replace' ? 'waiting' : 'cancelled')
  expect(f.request.mock.calls.filter(([input]) => url(input).endsWith('/request'))).toHaveLength(action === 'replace' ? 2 : 1)
  old.resolve(new Response('{"status":"completed"}'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).not.toHaveBeenCalled()
})

it.each(['request', 'cancel'] as const)('checks expiry when decoding a %s creation response consumes its remaining lifetime', async (action) => {
  const f = fixture('zh', { requestTtlMs: 2000 })
  const normal = f.request.getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  if (action === 'cancel') {
    f.request.mockReturnValueOnce(pending.promise)
    await create()
  }
  f.request.mockImplementationOnce(async (...args) => {
    const response = await normal(...args)
    const json = response.json.bind(response)
    vi.spyOn(response, 'json').mockImplementation(async () => {
      const value: unknown = await json()
      vi.spyOn(performance, 'now').mockReturnValue(2001)
      return value
    })
    return response
  })
  if (action === 'request') await create()
  else { button('cancel').click(); await vi.advanceTimersByTimeAsync(0) }
  expect(state()).toBe(action === 'request' ? 'expired' : 'cancelled')
  expect(f.pool.list()).toEqual([])
  expect(f.navigate).not.toHaveBeenCalled()
  pending.resolve(new Response('{}'))
  await vi.advanceTimersByTimeAsync(0)
})

it('ignores a disposed authorization check and does not restart it on pageshow', async () => {
  const f = fixture('zh', { requestTtlMs: 2000 })
  await create()
  const old = Promise.withResolvers<Response>()
  f.request.mockResolvedValueOnce(new Response('{"status":"pending"}')).mockReturnValueOnce(old.promise)
  await vi.advanceTimersByTimeAsync(2000)
  expect(state()).toBe('checking')
  dispose?.()
  dispose = undefined
  old.resolve(new Response(null, { status: 200 }))
  window.dispatchEvent(new Event('pageshow'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not duplicate a pending action when queued clicks arrive after controls become disabled', async () => {
  const f = fixture()
  const old = Promise.withResolvers<Response>()
  f.request.mockReturnValueOnce(old.promise)
  await create()
  button('request').dispatchEvent(new Event('click'))
  expect(f.request).toHaveBeenCalledOnce()
  button('cancel').click()
  button('cancel').dispatchEvent(new Event('click'))
  await vi.advanceTimersByTimeAsync(0)
  expect(state()).toBe('cancelled')
  expect(f.pool.list()).toEqual([])
  old.resolve(new Response('{}'))
  await vi.advanceTimersByTimeAsync(0)
})

it('resumes without issuing requests when no applicant exists and ignores duplicate pageshow', async () => {
  const f = fixture()
  window.dispatchEvent(new Event('pageshow'))
  window.dispatchEvent(new Event('pagehide'))
  button('request').click()
  button('cancel').dispatchEvent(new Event('click'))
  window.dispatchEvent(new Event('pageshow'))
  window.dispatchEvent(new Event('pageshow'))
  expect(f.request).not.toHaveBeenCalled()
  await create()
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(new Event('pageshow'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.request.mock.calls.filter(([input]) => url(input).endsWith('/request'))).toHaveLength(1)
  expect(state()).toBe('waiting')
})

it.each(['replace', 'cancel'] as const)('checks authorization when a %s response reports Host expiry', async (action) => {
  const f = fixture()
  await create()
  f.request.mockResolvedValueOnce(new Response('{"status":"expired"}'))
  if (action === 'replace') await create()
  else { button('cancel').click(); await vi.advanceTimersByTimeAsync(0) }
  expect(f.request.mock.calls[2]?.[1]?.method).toBe('HEAD')
  if (action === 'replace') await vi.advanceTimersByTimeAsync(1000)
  expect(state()).toBe(action === 'replace' ? 'waiting' : 'cancelled')
})

it('recovers and cancels an unknown creation after its local deadline before enabling another applicant', async () => {
  const f = fixture('zh', { requestTtlMs: 2000 })
  const old = Promise.withResolvers<Response>()
  f.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(old.promise)
  await create()
  await vi.advanceTimersByTimeAsync(2000)
  expect(state()).toBe('expired')
  expect(f.pool.list()).toEqual([])
  expect(url(f.request.mock.calls.at(-1)?.[0])).toMatch(/\/pairing\/cancel$/u)
  old.resolve(new Response('{}'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.navigate).not.toHaveBeenCalled()
})
