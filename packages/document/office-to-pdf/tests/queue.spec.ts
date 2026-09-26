/** Controlled source and engine completions exercise admission and shared content ownership. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConversionQueue } from '../src/queue.ts'
import { Config, OfficeSourceKey, OfficeToPdfGeneration, type OfficeToPdfRequest } from '../src/index.ts'

const output = { pdf: new Uint8Array([37, 80, 68, 70]), missingFonts: ['Font'] }
function source(key: string, byte = 1, priority: OfficeToPdfRequest['priority'] = 'foreground') {
  const read = vi.fn<OfficeToPdfRequest['source']['read']>().mockResolvedValue({ bytes: new Uint8Array([byte]), version: 'v1' })
  const request: OfficeToPdfRequest = { extension: 'docx', priority, source: { key: OfficeSourceKey(key), version: 'v1', bytes: 1, read } }
  return { read, request }
}
function harness(config: Partial<Config> = {}) {
  const convert = vi.fn<ConstructorParameters<typeof ConversionQueue>[2]>().mockResolvedValue(output)
  const queue = new ConversionQueue(Config(config), OfficeToPdfGeneration('test'), convert)
  onTestFinished(() => queue.dispose())
  return { queue, convert }
}

it('shares authorized source metadata before reading and content across distinct source paths', async () => {
  const h = harness()
  const entered = Promise.withResolvers<undefined>()
  const complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const a = source('a'), b = source('b')
  const first = h.queue.read(a.request)
  await entered.promise
  const same = h.queue.read(a.request)
  const equalContent = h.queue.read(b.request)
  try {
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    expect(a.read).toHaveBeenCalledOnce()
    expect(h.convert).toHaveBeenCalledOnce()
  } finally { complete.resolve(output) }
  const results = await Promise.all([first, same, equalContent])
  expect(new Set(results.map(result => result.cacheKey)).size).toBe(1)
  results[0].pdf[0] = 0
  results[0].missingFonts.length = 0
  expect(results[1].pdf).toEqual(output.pdf)
  expect((await h.queue.read(b.request)).missingFonts).toEqual(['Font'])
  expect(b.read).toHaveBeenCalledOnce()
})

it('continues queued work when the first queued reader cancels immediately after admission', async () => {
  const h = harness({ maxConcurrentConversions: 1 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read(source('active', 1).request)
  await entered.promise
  const cancelled = new AbortController()
  const second = source('cancelled', 2), third = source('later', 3)
  second.read.mockImplementation(async () => {
    cancelled.abort()
    return { bytes: new Uint8Array([2]), version: 'v1' }
  })
  const queued = h.queue.read(second.request, cancelled.signal)
  const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
  const later = h.queue.read(third.request)
  try {
    expect(second.read).not.toHaveBeenCalled()
    expect(third.read).not.toHaveBeenCalled()
  } finally { complete.resolve(output) }
  await first
  await rejected
  await expect(later).resolves.toMatchObject(output)
  expect(second.read).toHaveBeenCalledOnce()
  expect(third.read).toHaveBeenCalledOnce()
  expect(h.convert).toHaveBeenCalledTimes(2)
})

it('promotes a queued prewarm when a foreground reader joins, without another source read', async () => {
  const h = harness({ maxConcurrentConversions: 1 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read(source('active', 1).request)
  await entered.promise
  const order: string[] = []
  const a = source('a', 2, 'background'), b = source('b', 3, 'background')
  a.read.mockImplementation(async () => { order.push('a'); return { bytes: new Uint8Array([2]), version: 'v1' } })
  b.read.mockImplementation(async () => { order.push('b'); return { bytes: new Uint8Array([3]), version: 'v1' } })
  const backgroundA = h.queue.read(a.request), backgroundB = h.queue.read(b.request)
  const foreground = h.queue.read({ ...b.request, priority: 'foreground' })
  expect(a.read).not.toHaveBeenCalled()
  expect(b.read).not.toHaveBeenCalled()
  complete.resolve(output)
  await Promise.all([first, backgroundA, backgroundB, foreground])
  expect(order).toEqual(['b', 'a'])
  expect(b.read).toHaveBeenCalledOnce()
})

it('evicts queued speculation for foreground work and bounds the metadata queue', async () => {
  const h = harness({ maxConcurrentConversions: 1, maxQueuedJobs: 1 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read(source('active').request)
  await entered.promise
  const prewarm = source('prewarm', 2, 'background')
  const discarded = expect(h.queue.read(prewarm.request)).rejects.toMatchObject({ code: 'busy' })
  const overflow = source('background-overflow', 4, 'background')
  await expect(h.queue.read(overflow.request)).rejects.toMatchObject({ code: 'busy' })
  expect(overflow.read).not.toHaveBeenCalled()
  const requested = source('requested', 3)
  const next = h.queue.read(requested.request)
  await expect(h.queue.read(source('overflow', 4).request)).rejects.toMatchObject({ code: 'busy' })
  await discarded
  expect(prewarm.read).not.toHaveBeenCalled()
  expect(requested.read).not.toHaveBeenCalled()
  complete.resolve(output)
  await Promise.all([first, next])
  expect(requested.read).toHaveBeenCalledOnce()
})

it('refuses disabled prewarming before reading a source while admitting foreground work', async () => {
  const h = harness({ maxBackgroundConversions: 0 })
  const a = source('a', 1, 'background')
  await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'busy' })
  expect(a.read).not.toHaveBeenCalled()
  expect(h.convert).not.toHaveBeenCalled()
  await h.queue.read({ ...a.request, priority: 'foreground' })
  expect(a.read).toHaveBeenCalledOnce()
})

it('refuses disabled prewarming joins and releases cancelled foreground capacity', async () => {
  const h = harness({ maxBackgroundConversions: 0, maxConcurrentConversions: 1, maxQueuedJobs: 1, maxReaders: 5 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const running = source('running', 1), queued = source('queued', 2), later = source('later', 3)
  const foreground = new AbortController(), background = new AbortController()
  const pending: Promise<unknown>[] = [h.queue.read(running.request)]
  const rejected = vi.fn()
  try {
    await entered.promise
    pending.push(h.queue.read(queued.request, foreground.signal).catch((error: unknown) => error))
    for (const item of [running, queued]) {
      pending.push(h.queue.read({ ...item.request, priority: 'background' }, background.signal).catch(rejected))
    }
    await expect.poll(() => rejected.mock.calls.length).toBe(2)
    expect(rejected.mock.calls).toEqual([[expect.objectContaining({ code: 'busy' })], [expect.objectContaining({ code: 'busy' })]])
    foreground.abort()
    const next = h.queue.read(later.request)
    pending.push(next)
    expect(queued.read).not.toHaveBeenCalled()
    expect(later.read).not.toHaveBeenCalled()
    complete.resolve(output)
    await expect(next).resolves.toMatchObject(output)
    await expect(h.queue.read({ ...running.request, priority: 'background' })).resolves.toMatchObject(output)
    expect(running.read).toHaveBeenCalledOnce()
    expect(later.read).toHaveBeenCalledOnce()
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally {
    foreground.abort()
    background.abort()
    complete.resolve(output)
    await Promise.allSettled(pending)
  }
})

it('reserves foreground capacity while limiting concurrent prewarming', async () => {
  const h = harness({ maxConcurrentConversions: 2, maxBackgroundConversions: 1 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read(source('first', 1, 'background').request)
  await entered.promise
  const second = source('second', 2, 'background')
  const background = h.queue.read(second.request)
  const foreground = source('foreground', 3)
  await h.queue.read(foreground.request)
  expect(second.read).not.toHaveBeenCalled()
  complete.resolve(output)
  await Promise.all([first, background])
})

it('holds reserved source capacity until canceled engine work actually settles', async () => {
  const h = harness({ maxConcurrentConversions: 2, maxInputBytes: 1, maxSourceBytes: 1 })
  const entered = Promise.withResolvers<AbortSignal>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce((_bytes, _extension, signal: AbortSignal) => { entered.resolve(signal); return complete.promise })
  const caller = new AbortController()
  const firstSource = source('first'), nextSource = source('next', 2)
  const first = expect(h.queue.read(firstSource.request, caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await entered.promise
  caller.abort()
  await first
  expect(signal.aborted).toBe(true)
  const next = h.queue.read(nextSource.request)
  expect(nextSource.read).not.toHaveBeenCalled()
  complete.resolve(output)
  await next
  await h.queue.read(firstSource.request)
  expect(firstSource.read).toHaveBeenCalledTimes(2)
})

it('bounds shared readers and leaves other readers alive after cancellation', async () => {
  const h = harness({ maxReaders: 2 })
  const entered = Promise.withResolvers<AbortSignal>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce((_bytes, _extension, signal: AbortSignal) => { entered.resolve(signal); return complete.promise })
  const a = source('a'), caller = new AbortController()
  const first = expect(h.queue.read(a.request, caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await entered.promise
  const second = h.queue.read(a.request)
  await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'busy' })
  caller.abort()
  await first
  expect(signal.aborted).toBe(false)
  complete.resolve(output)
  await second
})

it('keeps digest-shared readers alive when the original source reader leaves', async () => {
  const h = harness()
  const entered = Promise.withResolvers<AbortSignal>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce((_bytes, _extension, signal: AbortSignal) => { entered.resolve(signal); return complete.promise })
  const a = source('a'), b = source('b'), caller = new AbortController()
  const first = expect(h.queue.read(a.request, caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await entered.promise
  const second = h.queue.read(b.request)
  await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
  caller.abort()
  await first
  expect(signal.aborted).toBe(false)
  complete.resolve(output)
  await second
  expect(h.convert).toHaveBeenCalledOnce()
})

it('rejects source version changes and oversized reads without converting or retaining them', async () => {
  const h = harness({ maxInputBytes: 2, maxSourceBytes: 2 })
  const a = source('a')
  a.read.mockResolvedValueOnce({ bytes: new Uint8Array([1]), version: 'v2' })
  await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'source-changed' })
  a.read.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2]), version: 'v1' })
  await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'input-too-large' })
  expect(h.convert).not.toHaveBeenCalled()
  await h.queue.read(a.request)
  expect(a.read).toHaveBeenCalledTimes(3)
  expect(a.read.mock.calls[0]![1]).toBe(1)
})

it('reserves the input cap for an unknown stat size and rejects known overflow before reading', async () => {
  const h = harness({ maxInputBytes: 2, maxSourceBytes: 2 })
  const a = source('a')
  await expect(h.queue.read({ ...a.request, source: { ...a.request.source, bytes: 3 } })).rejects.toMatchObject({ code: 'input-too-large' })
  expect(a.read).not.toHaveBeenCalled()
  const { bytes: _bytes, ...unknown } = a.request.source
  await h.queue.read({ ...a.request, source: unknown })
  expect(a.read.mock.calls[0]![1]).toBe(2)
})

it('evicts least-recently-used content and bounds pre-read aliases independently', async () => {
  const h = harness({ maxCachedEntries: 2, maxCachedBytes: 8, maxSourceEntries: 1 })
  const a = source('a', 1), alias = source('alias', 1), b = source('b', 2), c = source('c', 3)
  await h.queue.read(a.request)
  await h.queue.read(alias.request)
  await h.queue.read(a.request)
  expect(a.read).toHaveBeenCalledTimes(2)
  expect(h.convert).toHaveBeenCalledOnce()
  await h.queue.read(b.request)
  await h.queue.read(a.request)
  await h.queue.read(c.request)
  await h.queue.read(b.request)
  expect(h.convert).toHaveBeenCalledTimes(4)
})

it('does not retain failures or PDFs above the retention budget', async () => {
  const h = harness({ maxCachedBytes: 1 })
  const a = source('a')
  h.convert.mockRejectedValueOnce(new Error('engine failure'))
  await expect(h.queue.read(a.request)).rejects.toThrow('engine failure')
  await h.queue.read(a.request)
  await h.queue.read(a.request)
  expect(h.convert).toHaveBeenCalledTimes(3)
})

it('evicts every alias of the least-recently-used PDF while preserving other aliases', async () => {
  const h = harness({ maxCachedEntries: 2 })
  const a = source('a', 1), alias = source('alias', 1), b = source('b', 2), c = source('c', 3)
  await h.queue.read(a.request)
  await h.queue.read(alias.request)
  await h.queue.read(b.request)
  await h.queue.read(c.request)
  await h.queue.read(b.request)
  expect(b.read).toHaveBeenCalledOnce()
  await h.queue.read(a.request)
  await h.queue.read(alias.request)
  expect(a.read).toHaveBeenCalledTimes(2)
  expect(alias.read).toHaveBeenCalledTimes(2)
  expect(h.convert).toHaveBeenCalledTimes(4)
})

it('keeps a synchronous abort replacement shareable after the old conversion settles late', async () => {
  const h = harness({ maxConcurrentConversions: 2 })
  const firstEntered = Promise.withResolvers<undefined>(), firstComplete = Promise.withResolvers<typeof output>()
  const replacementEntered = Promise.withResolvers<undefined>(), replacementComplete = Promise.withResolvers<typeof output>()
  const replacementSpawned = Promise.withResolvers<{ work: ReturnType<ConversionQueue['read']> }>()
  const a = source('a'), caller = new AbortController()
  const pending: Promise<unknown>[] = []
  h.convert.mockImplementationOnce((_bytes, _extension, signal) => {
    signal.addEventListener('abort', () => {
      const work = h.queue.read(a.request)
      pending.push(work)
      replacementSpawned.resolve({ work })
    }, { once: true })
    firstEntered.resolve(undefined)
    return firstComplete.promise
  })
    .mockImplementationOnce(() => { replacementEntered.resolve(undefined); return replacementComplete.promise })
  const first = expect(h.queue.read(a.request, caller.signal)).rejects.toMatchObject({ cause: 'reader left' })
  pending.push(first)
  try {
    await firstEntered.promise
    caller.abort('reader left')
    await first
    const { work: replacement } = await replacementSpawned.promise
    await replacementEntered.promise
    const next = h.queue.read(source('next', 2).request)
    pending.push(next)
    firstComplete.resolve(output)
    await next
    const sameSource = h.queue.read(a.request)
    const alias = source('alias', 1, 'background')
    const sameContent = h.queue.read(alias.request)
    pending.push(sameSource, sameContent)
    await vi.waitFor(() => { expect(alias.read).toHaveBeenCalledOnce() })
    expect(a.read).toHaveBeenCalledTimes(2)
    expect(h.convert).toHaveBeenCalledTimes(3)
    replacementComplete.resolve(output)
    const results = await Promise.all([replacement, sameSource, sameContent])
    expect(new Set(results.map(result => result.cacheKey)).size).toBe(1)
  } finally {
    firstComplete.resolve(output)
    replacementComplete.resolve(output)
    await Promise.allSettled(pending)
  }
})

it('separates Office extensions and converter generations in content identity', async () => {
  const h = harness(), a = source('a')
  const first = await h.queue.read(a.request)
  const otherFormat = await h.queue.read({ ...a.request, extension: 'pptx' })
  const other = new ConversionQueue(Config({}), OfficeToPdfGeneration('replacement'), h.convert)
  onTestFinished(() => other.dispose())
  const replacement = await other.read(a.request)
  expect(first.cacheKey).not.toBe(otherFormat.cacheKey)
  expect(first.cacheKey).not.toBe(replacement.cacheKey)
})

it('reserves the final reader admission for foreground interest', async () => {
  const h = harness({ maxReaders: 2 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const a = source('a', 1, 'background')
  const background = h.queue.read(a.request)
  await entered.promise
  await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'busy' })
  const foreground = h.queue.read({ ...a.request, priority: 'foreground' })
  complete.resolve(output)
  await Promise.all([background, foreground])
  expect(a.read).toHaveBeenCalledOnce()
})

it('serves ready PDFs while every outstanding reader slot is occupied', async () => {
  const h = harness({ maxReaders: 1 }), cached = source('cached')
  await h.queue.read(cached.request)
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const pending = h.queue.read(source('active', 2).request)
  try {
    await entered.promise
    await expect(h.queue.read(cached.request)).resolves.toMatchObject(output)
    expect(cached.read).toHaveBeenCalledOnce()
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally { complete.resolve(output); await pending }
})

it('keeps background reservations behind foreground work waiting for source capacity', async () => {
  const h = harness({ maxInputBytes: 50, maxSourceBytes: 60, maxConcurrentConversions: 2 })
  const running = source('running', 1), foreground = source('foreground', 2), background = source('background', 3, 'background')
  const entered = Promise.withResolvers<undefined>(), foregroundEntered = Promise.withResolvers<undefined>()
  const complete = Promise.withResolvers<typeof output>(), foregroundComplete = Promise.withResolvers<typeof output>()
  const order: number[] = []
  h.convert.mockImplementation((bytes) => {
    order.push(bytes[0]!)
    if (bytes[0] === 1) { entered.resolve(undefined); return complete.promise }
    if (bytes[0] === 2) { foregroundEntered.resolve(undefined); return foregroundComplete.promise }
    return Promise.resolve(output)
  })
  const first = h.queue.read({ ...running.request, source: { ...running.request.source, bytes: 15 } })
  await entered.promise
  const next = h.queue.read({ ...foreground.request, source: { ...foreground.request.source, bytes: 48 } })
  const speculative = h.queue.read({ ...background.request, source: { ...background.request.source, bytes: 45 } })
  try {
    expect(foreground.read).not.toHaveBeenCalled()
    expect(background.read).not.toHaveBeenCalled()
    complete.resolve(output)
    await foregroundEntered.promise
    expect(order).toEqual([1, 2])
  } finally {
    complete.resolve(output)
    foregroundComplete.resolve(output)
    await Promise.allSettled([first, next, speculative])
  }
  expect(order).toEqual([1, 2, 3])
})

it('starts eligible background work when its queued foreground blocker is cancelled', async () => {
  const h = harness({ maxInputBytes: 50, maxSourceBytes: 60, maxConcurrentConversions: 2 })
  const running = source('running', 1), foreground = source('foreground', 2), background = source('background', 3, 'background')
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read({ ...running.request, source: { ...running.request.source, bytes: 15 } })
  const caller = new AbortController()
  let speculative: Promise<unknown> | undefined
  try {
    await entered.promise
    const cancelled = expect(h.queue.read({ ...foreground.request, source: { ...foreground.request.source, bytes: 48 } }, caller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    speculative = h.queue.read({ ...background.request, source: { ...background.request.source, bytes: 45 } })
    expect(background.read).not.toHaveBeenCalled()
    caller.abort()
    await cancelled
    expect(foreground.read).not.toHaveBeenCalled()
    expect(background.read).toHaveBeenCalledOnce()
    await speculative
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally { caller.abort(); complete.resolve(output); await Promise.allSettled([first, speculative]) }
})

it('starts eligible background work after a queued promotion loses its final foreground reader', async () => {
  const h = harness({ maxInputBytes: 50, maxSourceBytes: 60, maxConcurrentConversions: 2 })
  const running = source('running', 1), promoted = source('promoted', 2, 'background'), background = source('background', 3, 'background')
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read({ ...running.request, source: { ...running.request.source, bytes: 15 } })
  const callers = [new AbortController(), new AbortController()]
  const pending: Promise<unknown>[] = [first]
  try {
    await entered.promise
    const request = { ...promoted.request, source: { ...promoted.request.source, bytes: 48 } }
    pending.push(h.queue.read(request))
    const cancelled = callers.map(caller => expect(h.queue.read({ ...request, priority: 'foreground' }, caller.signal))
      .rejects.toMatchObject({ name: 'AbortError' }))
    pending.push(...cancelled)
    pending.push(h.queue.read({ ...background.request, source: { ...background.request.source, bytes: 45 } }))
    expect(background.read).not.toHaveBeenCalled()
    callers[0]!.abort()
    await cancelled[0]
    expect(background.read).not.toHaveBeenCalled()
    callers[1]!.abort()
    await cancelled[1]
    expect(promoted.read).not.toHaveBeenCalled()
    expect(background.read).toHaveBeenCalledOnce()
  } finally {
    for (const caller of callers) caller.abort()
    complete.resolve(output)
    await Promise.allSettled(pending)
  }
})

it('counts a demoted queued prewarm against background concurrency when it starts', async () => {
  const h = harness({ maxConcurrentConversions: 2, maxBackgroundConversions: 1 })
  const complete = Promise.withResolvers<typeof output>(), prewarmComplete = Promise.withResolvers<typeof output>()
  const prewarmEntered = Promise.withResolvers<undefined>()
  h.convert.mockImplementation((bytes) => {
    if (bytes[0] === 1 || bytes[0] === 2) return complete.promise
    if (bytes[0] === 3) { prewarmEntered.resolve(undefined); return prewarmComplete.promise }
    return Promise.resolve(output)
  })
  const first = h.queue.read(source('first', 1).request), second = h.queue.read(source('second', 2).request)
  const prewarm = source('promoted', 3, 'background'), other = source('other', 4, 'background')
  const warming = h.queue.read(prewarm.request), waiting = h.queue.read(other.request)
  const caller = new AbortController()
  const cancelled = expect(h.queue.read({ ...prewarm.request, priority: 'foreground' }, caller.signal))
    .rejects.toMatchObject({ name: 'AbortError' })
  try {
    expect(prewarm.read).not.toHaveBeenCalled()
    caller.abort()
    await cancelled
    complete.resolve(output)
    await prewarmEntered.promise
    await h.queue.read(source('foreground', 5).request)
    expect(other.read).not.toHaveBeenCalled()
  } finally {
    caller.abort()
    complete.resolve(output)
    prewarmComplete.resolve(output)
    await Promise.allSettled([first, second, warming, waiting, cancelled])
  }
})

it('releases source indexes when the last reader for each digest-shared path leaves', async () => {
  const h = harness({ maxReaders: 2, maxSourceEntries: 2 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read(source('retained').request)
  await entered.promise
  // Both retained indexes must stay bounded while the underlying converter is blocked.
  const indexes = h.queue as unknown as { sources: Map<string, { sources: Set<string> }> }
  const retained = [...indexes.sources.values()][0]!
  try {
    for (let index = 0; index < 5; index++) {
      const alias = source(`cancelled-${index}`), caller = new AbortController()
      const joined = h.queue.read(alias.request, caller.signal)
      const rejected = expect(joined).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => { expect(retained.sources.size).toBe(2) })
      caller.abort()
      await rejected
      expect(indexes.sources.size).toBe(1)
      expect(retained.sources.size).toBe(1)
    }
    expect(h.convert).toHaveBeenCalledOnce()
  } finally { complete.resolve(output); await first }
})

it('rereads a cancelled source on reopen while sharing its running or completed conversion', async () => {
  const h = harness({ maxReaders: 2, maxSourceEntries: 2 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const first = h.queue.read(source('retained').request), reopened = source('reopened')
  try {
    await entered.promise
    for (const count of [1, 2]) {
      const caller = new AbortController()
      const cancelled = expect(h.queue.read(reopened.request, caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      try { await vi.waitFor(() => { expect(reopened.read).toHaveBeenCalledTimes(count) }) }
      finally { caller.abort(); await cancelled }
    }
    complete.resolve(output)
    await first
    await h.queue.read(reopened.request)
    expect(reopened.read).toHaveBeenCalledTimes(3)
    await h.queue.read(reopened.request)
    expect(reopened.read).toHaveBeenCalledTimes(3)
    expect(h.convert).toHaveBeenCalledOnce()
  } finally { complete.resolve(output); await first }
})

it('keeps speculative admission occupied after promotion while allowing other foreground work', async () => {
  const h = harness({ maxConcurrentConversions: 2, maxBackgroundConversions: 1 })
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const original = source('original', 1, 'background'), waiting = source('waiting', 2, 'background')
  const first = h.queue.read(original.request)
  await entered.promise
  const promoted = h.queue.read({ ...original.request, priority: 'foreground' })
  const speculative = h.queue.read(waiting.request)
  try {
    await h.queue.read(source('requested', 3).request)
    expect(waiting.read).not.toHaveBeenCalled()
  } finally { complete.resolve(output); await Promise.all([first, promoted, speculative]) }
  expect(waiting.read).toHaveBeenCalledOnce()
})

it('classifies provider disposal independently from caller cancellation', async () => {
  const h = harness()
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<typeof output>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const pending = expect(h.queue.read(source('active').request)).rejects.toMatchObject({ code: 'unavailable' })
  await entered.promise
  const closing = h.queue.dispose()
  try {
    await pending
    await expect(h.queue.read(source('later').request)).rejects.toMatchObject({ code: 'unavailable' })
  } finally { complete.resolve(output); await closing }
})
