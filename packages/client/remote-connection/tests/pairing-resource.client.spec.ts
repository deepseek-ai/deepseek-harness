/** Pending-list polling is held by a view and never survives its resource release. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PairingRequestId, PairingRequestsValue } from '../src/types.ts'
import { requestsResource } from '../src/client/pairing-resource.ts'

afterEach(() => { vi.useRealTimers() })

const value: PairingRequestsValue = { requests: [], pollIntervalMs: 1000 }
const firstId = 'request-one' as PairingRequestId
const secondId = 'request-two' as PairingRequestId
const listed: PairingRequestsValue = {
  requests: [firstId, secondId].map((id, index) => ({
    id, code: index === 0 ? 'ABCD2345' : 'WXYZ6789', authority: 'https://host.example', sourceIp: '192.0.2.17', expiresInMs: 60_000,
  })),
  pollIntervalMs: 1000,
}
const remaining: PairingRequestsValue = { ...listed, requests: listed.requests.slice(1) }
const address = 'dsh-resource://device-pairing/requests'

it('polls with the server interval and releases the timer on abort', async () => {
  vi.useFakeTimers()
  const requests = vi.fn(async () => ({ ok: true as const, value }))
  const controller = new AbortController()
  const stream = requestsResource({ pairingRequests: requests }).provider.open('dsh-resource://device-pairing/requests', { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    expect(await stream.next()).toEqual({ done: false, value: { ok: true, value } })
    const next = stream.next()
    await vi.advanceTimersByTimeAsync(999)
    expect(requests).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(await next).toMatchObject({ done: false })
    expect(requests).toHaveBeenCalledTimes(2)
    const released = stream.next()
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await released).toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
  } finally { controller.abort(); await stream.return?.() }
})

it.each(['refused', 'disconnected', 'typed-error'] as const)('yields a %s read as a resource failure', async (failure) => {
  const requests = vi.fn<() => Promise<RemoteResult<PairingRequestsValue>>>()
  const ownerRequired = new RemoteError('remote-connection/owner-required', 'Owner required.', {})
  if (failure === 'refused') requests.mockResolvedValue({ ok: false, error: ownerRequired })
  else if (failure === 'typed-error') requests.mockRejectedValue(ownerRequired)
  else requests.mockRejectedValue(new Error('disconnected'))
  const controller = new AbortController()
  const stream = requestsResource({ pairingRequests: requests }).provider.open('dsh-resource://device-pairing/requests', { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    expect(await stream.next()).toMatchObject({ done: false, value: {
      ok: false, error: { code: failure === 'disconnected' ? 'pairing/read-failed' : 'remote-connection/owner-required' },
    } })
    controller.abort()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  } finally { controller.abort(); await stream.return?.() }
})

it.each(['response', 'rejection'] as const)('ignores an in-flight %s after release and never reads an already aborted resource', async (outcome) => {
  const pending = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const requests = vi.fn(() => pending.promise)
  const controller = new AbortController()
  const { provider } = requestsResource({ pairingRequests: requests })
  const stream = provider.open('dsh-resource://device-pairing/requests', { signal: controller.signal })[Symbol.asyncIterator]()
  const next = stream.next()
  controller.abort()
  if (outcome === 'response') pending.resolve({ ok: true, value })
  else pending.reject(new Error('transport aborted'))
  expect(await next).toEqual({ done: true, value: undefined })
  const stopped = provider.open('dsh-resource://device-pairing/requests', { signal: controller.signal })[Symbol.asyncIterator]()
  expect(await stopped.next()).toEqual({ done: true, value: undefined })
  expect(requests).toHaveBeenCalledOnce()
})

it('publishes confirmed removals from a live list and waits for a successful read after failure', async () => {
  vi.useFakeTimers()
  const refresh = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const recovery = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const requests = vi.fn<() => Promise<RemoteResult<PairingRequestsValue>>>()
    .mockResolvedValueOnce({ ok: true, value: listed }).mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(recovery.promise)
  const ctx = new Context()
  const resources = new ResourceRegistry(ctx)
  const owner = requestsResource({ pairingRequests: requests })
  const release = resources.register(owner.provider)
  const source = resources.source(address)
  const ready = Promise.withResolvers<undefined>()
  const failed = Promise.withResolvers<undefined>()
  const statuses: string[] = []
  const unsubscribe = source.subscribe(() => {
    const { status } = source.getSnapshot()
    statuses.push(status)
    if (status === 'live') ready.resolve(undefined)
    if (status === 'failed') failed.resolve(undefined)
  })
  try {
    await ready.promise
    expect(source.getSnapshot().value).toEqual(listed)
    await owner.confirmed(firstId)
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: remaining })
    expect(requests).toHaveBeenCalledTimes(2)
    refresh.reject(new Error('disconnected'))
    await failed.promise
    expect(source.getSnapshot()).toMatchObject({
      status: 'failed', value: remaining, failure: { code: 'pairing/read-failed' },
    })
    expect(vi.getTimerCount()).toBe(0)
    await owner.confirmed(secondId)
    expect(source.getSnapshot()).toMatchObject({
      status: 'failed', failure: { code: 'pairing/read-failed' },
    })
    expect(statuses).toEqual(['live', 'live', 'failed'])
    expect(requests).toHaveBeenCalledTimes(3)
    const recovered = Promise.withResolvers<undefined>()
    const stopWatching = source.subscribe(() => {
      if (source.getSnapshot().status === 'live') recovered.resolve(undefined)
    })
    try {
      recovery.resolve({ ok: true, value })
      await recovered.promise
      expect(source.getSnapshot()).toMatchObject({ status: 'live', value, failure: undefined })
    } finally { stopWatching() }
  } finally {
    unsubscribe()
    release()
    await ctx.fiber.dispose()
  }
})

it('acknowledges immediately while the initial list is unresolved and replaces the old read', async () => {
  const first = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const fresh = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const requests = vi.fn<(signal: AbortSignal) => Promise<RemoteResult<PairingRequestsValue>>>()
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(fresh.promise)
  const owner = requestsResource({ pairingRequests: requests })
  const controller = new AbortController()
  const stream = owner.provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    const initial = stream.next()
    await owner.confirmed(firstId)
    expect(requests.mock.calls[0]?.[0].aborted).toBe(true)
    expect(requests).toHaveBeenCalledTimes(2)
    first.resolve({ ok: true, value: listed })
    fresh.resolve({ ok: true, value: remaining })
    expect(await initial).toEqual({ done: false, value: { ok: true, value: remaining } })
  } finally { controller.abort(); await stream.return?.() }
})

it('keeps a failed list idle until a manual retry opens a fresh resource', async () => {
  vi.useFakeTimers()
  const requests = vi.fn<() => Promise<RemoteResult<PairingRequestsValue>>>()
    .mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce({ ok: true, value: listed })
  const { provider } = requestsResource({ pairingRequests: requests })
  const controller = new AbortController()
  const stream = provider.open(`${address}?retry=0`, { signal: controller.signal })[Symbol.asyncIterator]()
  const retryController = new AbortController()
  const retry = provider.open(`${address}?retry=1`, { signal: retryController.signal })[Symbol.asyncIterator]()
  try {
    expect(await stream.next()).toMatchObject({ done: false, value: { ok: false } })
    const closed = stream.next()
    await vi.advanceTimersByTimeAsync(5000)
    expect(requests).toHaveBeenCalledOnce()
    controller.abort()
    expect(await closed).toEqual({ done: true, value: undefined })
    expect(await retry.next()).toEqual({ done: false, value: { ok: true, value: listed } })
    expect(requests).toHaveBeenCalledTimes(2)
  } finally {
    controller.abort()
    retryController.abort()
    await stream.return?.()
    await retry.return?.()
  }
})

it.each(['response', 'rejection'] as const)('discards a late %s from the read started before confirmation', async (outcome) => {
  vi.useFakeTimers()
  const stale = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const fresh = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const requests = vi.fn<(signal: AbortSignal) => Promise<RemoteResult<PairingRequestsValue>>>()
    .mockResolvedValueOnce({ ok: true, value: listed }).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  const owner = requestsResource({ pairingRequests: requests })
  const controller = new AbortController()
  const stream = owner.provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    await stream.next()
    const waiting = stream.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveBeenCalledTimes(2)
    const confirmed = owner.confirmed(firstId)
    expect(requests.mock.calls[1]?.[0].aborted).toBe(true)
    expect(await waiting).toEqual({ done: false, value: { ok: true, value: remaining } })
    const refreshed = stream.next()
    await confirmed
    expect(requests).toHaveBeenCalledTimes(3)
    let delivered = false
    void refreshed.then(() => { delivered = true })
    if (outcome === 'response') stale.resolve({ ok: true, value: listed })
    else stale.reject(new Error('old read failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered).toBe(false)
    fresh.resolve({ ok: true, value: remaining })
    expect(await refreshed).toEqual({ done: false, value: { ok: true, value: remaining } })
  } finally { controller.abort(); await stream.return?.() }
})

it.each(['abort', 'return'] as const)('waits for removal consumption and releases its confirmation on %s', async (method) => {
  vi.useFakeTimers()
  const requests = vi.fn(async () => ({ ok: true as const, value: listed }))
  const owner = requestsResource({ pairingRequests: requests })
  await owner.confirmed(firstId)
  expect(requests).not.toHaveBeenCalled()
  const controller = new AbortController()
  const stream = owner.provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    expect(await stream.next()).toEqual({ done: false, value: { ok: true, value: listed } })
    let acknowledged = false
    const confirmed = owner.confirmed(firstId).then(() => { acknowledged = true })
    expect(await stream.next()).toEqual({ done: false, value: { ok: true, value: remaining } })
    expect(acknowledged).toBe(false)
    if (method === 'abort') controller.abort()
    else await stream.return?.()
    await confirmed
    expect(acknowledged).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await owner.confirmed(secondId)
    expect(requests).toHaveBeenCalledOnce()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  } finally { controller.abort(); await stream.return?.() }
})

it('acknowledges confirmation on a failed list and aborts the fresh read when closed', async () => {
  vi.useFakeTimers()
  const error = new RemoteError('pairing/read-failed', 'Could not read pairing requests.', {})
  const fresh = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const requests = vi.fn<(signal: AbortSignal) => Promise<RemoteResult<PairingRequestsValue>>>()
    .mockResolvedValueOnce({ ok: true, value: listed })
    .mockResolvedValueOnce({ ok: false, error })
    .mockReturnValueOnce(fresh.promise)
  const owner = requestsResource({ pairingRequests: requests })
  const controller = new AbortController()
  const stream = owner.provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    await stream.next()
    const failure = stream.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await failure).toEqual({ done: false, value: { ok: false, error } })
    const latest = stream.next()
    await owner.confirmed(firstId)
    expect(requests).toHaveBeenCalledTimes(3)
    controller.abort()
    expect(requests.mock.calls[2]?.[0].aborted).toBe(true)
    expect(await latest).toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
  } finally { controller.abort(); await stream.return?.() }
})

it('releases a waiting confirmation and abandons an unresolved fresh read when the last subscriber leaves', async () => {
  const pending = Promise.withResolvers<RemoteResult<PairingRequestsValue>>()
  const requests = vi.fn<(signal: AbortSignal) => Promise<RemoteResult<PairingRequestsValue>>>()
    .mockResolvedValueOnce({ ok: true, value: listed }).mockReturnValueOnce(pending.promise)
  const ctx = new Context()
  const resources = new ResourceRegistry(ctx)
  const owner = requestsResource({ pairingRequests: requests })
  const release = resources.register(owner.provider)
  const source = resources.source(address)
  const ready = Promise.withResolvers<undefined>()
  const unsubscribe = source.subscribe(() => {
    if (source.getSnapshot().status === 'live') ready.resolve(undefined)
  })
  try {
    await ready.promise
    await owner.confirmed(firstId)
    expect(requests).toHaveBeenCalledTimes(2)
    const confirmed = owner.confirmed(secondId)
    unsubscribe()
    await confirmed
    expect(requests.mock.calls[1]?.[0].aborted).toBe(true)
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', value: undefined })
    pending.resolve({ ok: true, value: listed })
    await owner.confirmed(firstId)
    expect(requests).toHaveBeenCalledTimes(2)
  } finally {
    unsubscribe()
    release()
    await ctx.fiber.dispose()
  }
})
