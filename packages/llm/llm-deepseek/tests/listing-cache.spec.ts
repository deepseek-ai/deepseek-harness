/** Credential-scoped listing cache: first-use waits, background refresh, retention, and disposal. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ModelListingCache } from '../src/listing-cache.ts'
import type { ListingSettings } from '../src/listing-config.ts'
import { LISTING_TIMEOUT } from '../src/listing.ts'
import type { ModelListing } from '../src/listing.ts'

afterEach(() => { vi.useRealTimers() })

const listing = (...ids: string[]): ModelListing => ({
  skipped: 0,
  entries: ids.map(id => ({ id, requirement: { kind: 'none' }, capabilities: { usable: true, facts: { inputModalities: ['text'] } } })),
})

function harness(timeoutMs = 60_000, honorsAbort = true) {
  let clock = 0
  let token: string | undefined = 'token-a'
  const loads: Array<{ token: string; signal: AbortSignal; settle: PromiseWithResolvers<ModelListing> }> = []
  const info = vi.fn()
  const warn = vi.fn()
  const changed = vi.fn()
  const settings: { -readonly [K in keyof ListingSettings]: ListingSettings[K] } = { url: 'https://api.example/models', timeoutMs, maxAgeMs: 100 }
  const resolveSettings = vi.fn<() => ListingSettings | undefined>(() => settings)
  const resolveCredential = vi.fn(() => Promise.resolve(token))
  const cache = new ModelListingCache({
    settings: resolveSettings,
    credential: resolveCredential,
    load: (_url, value, signal) => {
      const settle = Promise.withResolvers<ModelListing>()
      if (honorsAbort) signal.addEventListener('abort', () => { settle.reject(signal.reason) }, { once: true })
      loads.push({ token: value, signal, settle })
      return settle.promise
    },
    now: () => clock,
    info,
    warn,
    changed,
  })
  onTestFinished(() => cache.dispose())
  const flush = () => new Promise(resolve => setImmediate(resolve))
  // Every access passes the same configuration generation.
  const catalog = {
    view: (signal?: AbortSignal) => cache.view(settings, signal),
    current: () => cache.current(),
    invalidate: () => { cache.invalidate() },
    dispose: () => cache.dispose(),
  }
  return {
    catalog, loads, info, warn, changed, flush, settings, resolveSettings, resolveCredential,
    advance: (ms: number) => { clock += ms },
    credential: (value: string | undefined) => { token = value },
  }
}

it('reports an unauthenticated view without loading', async () => {
  const { catalog, loads, credential } = harness()
  credential(undefined)
  await expect(catalog.view()).resolves.toEqual({ authenticated: false, listing: undefined })
  expect(loads).toEqual([])
})

it('shares one first load between concurrent callers', async () => {
  const { catalog, loads, info, flush } = harness()
  const first = catalog.view()
  const second = catalog.view()
  await flush()
  expect(loads).toHaveLength(1)
  loads[0]!.settle.resolve(listing('a'))
  await expect(first).resolves.toEqual({ authenticated: true, listing: listing('a') })
  await expect(second).resolves.toEqual({ authenticated: true, listing: listing('a') })
  expect(catalog.current()).toEqual({ authenticated: true, listing: listing('a') })
  expect(info).toHaveBeenCalledExactlyOnceWith('model listing from https://api.example/models loaded 1 model(s), skipped 0 row(s)')
})

it('bounds the first wait by the request deadline and serves no listing after a failure', async () => {
  const { catalog, loads, warn } = harness(5)
  await expect(catalog.view()).resolves.toEqual({ authenticated: true, listing: undefined })
  expect(timeoutOf(loads[0]!.signal, LISTING_TIMEOUT)?.timeoutMs).toBe(5)
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('using the bundled catalog'))
})

it('abandons only the caller\'s wait when its signal aborts', async () => {
  const { catalog, loads, flush } = harness()
  const controller = new AbortController()
  const waiting = catalog.view(controller.signal)
  await flush()
  controller.abort(new Error('caller left'))
  await expect(waiting).rejects.toThrow('caller left')
  expect(loads[0]!.signal.aborted).toBe(false)
  loads[0]!.settle.resolve(listing('a'))
  await flush()
  await expect(catalog.view()).resolves.toMatchObject({ listing: listing('a') })
})

it('rejects a caller whose signal is already aborted', async () => {
  const { catalog } = harness()
  await expect(catalog.view(AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone')
})

it('refreshes a stale listing in the background and keeps it through a failing streak', async () => {
  const { catalog, loads, warn, flush, advance } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(listing('a'))
  await first
  advance(50)
  await catalog.view()
  expect(loads).toHaveLength(1)
  advance(50)
  await expect(catalog.view()).resolves.toMatchObject({ listing: listing('a') })
  expect(loads).toHaveLength(2)
  loads[1]!.settle.reject(new Error('down'))
  await flush()
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('keeping the previous catalog'))
  advance(100)
  await catalog.view()
  loads[2]!.settle.reject(new Error('still down'))
  await flush()
  expect(warn).toHaveBeenCalledTimes(1)
  advance(100)
  await catalog.view()
  loads[3]!.settle.resolve(listing('a', 'b'))
  await flush()
  expect(catalog.current().listing).toEqual(listing('a', 'b'))
  advance(100)
  await catalog.view()
  loads[4]!.settle.reject(new Error('down again'))
  await flush()
  expect(warn).toHaveBeenCalledTimes(2)
})

it('rescopes on another credential and discards the previous credential\'s result', async () => {
  const { catalog, loads, flush, credential } = harness()
  const first = catalog.view()
  await flush()
  credential('token-b')
  const second = catalog.view()
  await flush()
  expect(loads[0]!.signal.aborted).toBe(true)
  expect(loads[1]!.token).toBe('token-b')
  loads[1]!.settle.resolve(listing('b'))
  await expect(second).resolves.toMatchObject({ listing: listing('b') })
  await first
  expect(catalog.current().listing).toEqual(listing('b'))
  credential(undefined)
  await expect(catalog.view()).resolves.toEqual({ authenticated: false, listing: undefined })
})

it('aborts in-flight work on dispose and loads nothing afterwards', async () => {
  const { catalog, loads, warn, flush } = harness()
  const waiting = catalog.view()
  await flush()
  await catalog.dispose()
  expect(loads[0]!.signal.aborted).toBe(true)
  await waiting
  await expect(catalog.view()).resolves.toEqual({ authenticated: true, listing: undefined })
  expect(loads).toHaveLength(1)
  expect(warn).not.toHaveBeenCalled()
})

it('drops a successful result that settles after disposal', async () => {
  const { catalog, loads, flush } = harness(60_000, false)
  const waiting = catalog.view()
  await flush()
  const disposal = catalog.dispose()
  loads[0]!.settle.resolve(listing('late'))
  await disposal
  await waiting
  expect(catalog.current().listing).toBeUndefined()
})

it('discards the listing on invalidation, so the next access waits for a fresh load', async () => {
  const { catalog, loads, flush } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(listing('a'))
  await first
  await catalog.view()
  expect(loads).toHaveLength(1)
  catalog.invalidate()
  expect(catalog.current()).toEqual({ authenticated: true, listing: undefined })
  const second = catalog.view()
  await flush()
  expect(loads).toHaveLength(2)
  loads[1]!.settle.resolve(listing('b'))
  await expect(second).resolves.toEqual({ authenticated: true, listing: listing('b') })
})

it('aborts an in-flight load on invalidation and ignores its result', async () => {
  const { catalog, loads, flush, warn } = harness(60_000, false)
  const waiting = catalog.view()
  await flush()
  catalog.invalidate()
  expect(loads[0]!.signal.aborted).toBe(true)
  loads[0]!.settle.resolve(listing('stale'))
  await waiting
  expect(catalog.current().listing).toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

const badgedListing = (text: string): ModelListing => ({
  ...listing('a'),
  entries: listing('a').entries.map(entry => ({ ...entry, badge: { kind: 'badge', badge: { text, tone: 'info' } } })),
})

it('automatically publishes replacement badges and their removal without another read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, flush, advance } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  for (const next of [badgedListing('Updated'), listing('a')]) {
    advance(100)
    await vi.advanceTimersByTimeAsync(100)
    const request = loads.at(-1)!
    expect(request).not.toBe(loads[0])
    request.settle.resolve(next)
    await flush()
    expect(catalog.current().listing).toEqual(next)
  }
  expect(loads).toHaveLength(3)
  expect(changed).toHaveBeenCalledTimes(3)
})

it.each(['failure', 'timeout'] as const)('retains badges after refresh %s and replaces them after recovery', async (failure) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, warn, flush, advance } = harness(50)
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  if (failure === 'timeout') {
    advance(50)
    await vi.advanceTimersByTimeAsync(50)
    expect(loads[1]!.signal.aborted).toBe(true)
  } else {
    loads[1]!.settle.reject(new Error('offline'))
  }
  await flush()
  expect(catalog.current().listing).toEqual(badgedListing('New'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeping the previous catalog'))
  expect(changed).toHaveBeenCalledTimes(1)
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  loads[2]!.settle.resolve(badgedListing('Updated'))
  await flush()
  expect(catalog.current().listing).toEqual(badgedListing('Updated'))
  expect(changed).toHaveBeenCalledTimes(2)
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  loads[3]!.settle.resolve(listing('a'))
  await flush()
  expect(catalog.current().listing).toEqual(listing('a'))
  expect(changed).toHaveBeenCalledTimes(3)
})

it('does not notify for identical listings and stops its timer on disposal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, flush, advance } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  loads[1]!.settle.resolve(badgedListing('New'))
  await flush()
  expect(changed).toHaveBeenCalledTimes(1)
  await catalog.dispose()
  advance(1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(loads).toHaveLength(2)
})

it('awaits an admitted automatic load on disposal and suppresses its late publication', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, flush, advance } = harness(60_000, false)
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  let disposed = false
  const disposal = catalog.dispose().then(() => { disposed = true })
  await flush()
  expect(disposed).toBe(false)
  expect(loads[1]!.signal.aborted).toBe(true)
  loads[1]!.settle.resolve(badgedListing('Late'))
  await disposal
  expect(catalog.current().listing).toEqual(badgedListing('New'))
  expect(changed).toHaveBeenCalledTimes(1)
})

it('keeps zero max age as access-only refresh without an automatic loop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, flush, advance, settings } = harness()
  settings.maxAgeMs = 0
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(listing('a'))
  await first
  advance(1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(loads).toHaveLength(1)
  await catalog.view()
  expect(loads).toHaveLength(2)
  loads[1]!.settle.resolve(listing('b'))
  await flush()
})

it('uses current configuration and stops following a disabled listing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, flush, advance, settings, resolveSettings } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  settings.maxAgeMs = 200
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  expect(loads).toHaveLength(1)
  resolveSettings.mockReturnValue(undefined)
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  expect(catalog.current().listing).toBeUndefined()
  expect(changed).toHaveBeenCalledTimes(2)
  advance(1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(loads).toHaveLength(1)
})

it('removes a signed-out listing and discovers a replacement credential automatically', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, flush, advance, credential } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  credential(undefined)
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  expect(catalog.current()).toEqual({ authenticated: false, listing: undefined })
  expect(changed).toHaveBeenCalledTimes(2)
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  expect(changed).toHaveBeenCalledTimes(2)
  credential('replacement')
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  expect(loads[1]!.token).toBe('replacement')
  loads[1]!.settle.resolve(listing('b'))
  await flush()
  expect(catalog.current().listing).toEqual(listing('b'))
})

it('retains badges on credential lookup failures, reports the streak once, and retries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, warn, flush, advance, resolveCredential } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(badgedListing('New'))
  await first
  resolveCredential.mockRejectedValue(new Error('credentials offline'))
  for (let index = 0; index < 2; index++) {
    advance(100)
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(catalog.current().listing).toEqual(badgedListing('New'))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('check listing configuration and credentials'))
  resolveCredential.mockResolvedValue('token-a')
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  loads[1]!.settle.resolve(badgedListing('Back'))
  await flush()
  expect(catalog.current().listing).toEqual(badgedListing('Back'))
  expect(changed).toHaveBeenCalledTimes(2)
})

it.each(['resolve', 'reject'] as const)('awaits a pending automatic credential lookup on disposal (%s)', async (outcome) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { catalog, loads, changed, warn, flush, advance, resolveCredential } = harness()
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(listing('a'))
  await first
  const credential = Promise.withResolvers<string | undefined>()
  resolveCredential.mockReturnValue(credential.promise)
  advance(100)
  await vi.advanceTimersByTimeAsync(100)
  let disposed = false
  const disposal = catalog.dispose().then(() => { disposed = true })
  await flush()
  expect(disposed).toBe(false)
  if (outcome === 'resolve') credential.resolve('token-a')
  else credential.reject(new Error('lookup failed'))
  await disposal
  expect(loads).toHaveLength(1)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(warn).not.toHaveBeenCalled()
})

it('keeps the committed listing and reports a failed change observer', async () => {
  const { catalog, loads, changed, warn, flush } = harness()
  changed.mockImplementation(() => { throw new Error('observer failed') })
  const first = catalog.view()
  await flush()
  loads[0]!.settle.resolve(listing('a'))
  await expect(first).resolves.toMatchObject({ listing: listing('a') })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('change notification failed'))
})
