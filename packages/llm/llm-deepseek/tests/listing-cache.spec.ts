/** Credential-scoped listing cache: first-use waits, background refresh, retention, and disposal. */
import { expect, it, vi } from 'vitest'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ModelListingCache } from '../src/listing-cache.ts'
import type { ListingSettings } from '../src/listing-config.ts'
import { LISTING_TIMEOUT } from '../src/listing.ts'
import type { ModelListing } from '../src/listing.ts'

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
  const settings: ListingSettings = { url: 'https://api.example/models', timeoutMs, maxAgeMs: 100 }
  const cache = new ModelListingCache({
    credential: () => Promise.resolve(token),
    load: (_url, value, signal) => {
      const settle = Promise.withResolvers<ModelListing>()
      if (honorsAbort) signal.addEventListener('abort', () => { settle.reject(signal.reason) }, { once: true })
      loads.push({ token: value, signal, settle })
      return settle.promise
    },
    now: () => clock,
    info,
    warn,
  })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  // Every access passes the same configuration generation.
  const catalog = {
    view: (signal?: AbortSignal) => cache.view(settings, signal),
    current: () => cache.current(),
    invalidate: () => { cache.invalidate() },
    dispose: () => { cache.dispose() },
  }
  return {
    catalog, loads, info, warn, flush,
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
  catalog.dispose()
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
  catalog.dispose()
  loads[0]!.settle.resolve(listing('late'))
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
