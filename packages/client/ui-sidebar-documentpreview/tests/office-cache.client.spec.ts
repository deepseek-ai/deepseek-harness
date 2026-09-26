/** Controlled conversion completions pin shared cancellation, freshness, and bounded binary reuse. */
import type { OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFile } from '../src/client/rpc.ts'
import type { ReadOfficeDocument } from '../src/client/office/cache.ts'
import { OfficePreviewCache } from '../src/client/office/cache.ts'

const file = { sessionId: 's1' as SessionId, path: 'report.docx' }
const result = (version = 'v1', text = 'pdf!', generation = 'renderer'): Awaited<ReturnType<ReadOfficeDocument>> => ({
  ok: true, value: { absolutePath: '/report.docx', version, offset: 0, eof: true, missingFonts: [], data: new TextEncoder().encode(text), generation: (generation as OfficeToPdfGeneration) },
})
function harness(entries = 2, bytes = 32, pending = 8, readers = 32) {
  const stat = vi.fn().mockResolvedValue({ ok: true, value: { absolutePath: '/report.docx', version: 'v1' } })
  const convert = vi.fn<import('../src/client/office/cache.ts').ReadOfficeBytes>().mockResolvedValue(result())
  const generation = vi.fn().mockResolvedValue({ ok: true, value: ('renderer' as OfficeToPdfGeneration) })
  const cache = new OfficePreviewCache(stat, convert, entries, bytes, pending, readers, generation, () => new Error('busy'))
  return { stat, convert, cache, generation, read: (signal = new AbortController().signal) => cache.read(file, signal) }
}

it('shares a pending conversion between readers and reauthorizes cached reads', async () => {
  const h = harness()
  const started = Promise.withResolvers<AbortSignal>()
  const completed = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementation((_file, signal) => { started.resolve(signal); return completed.promise })
  const background = new AbortController()
  const first = h.read(background.signal)
  const aborted = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const conversionSignal = await started.promise
  const second = h.read()
  await vi.waitFor(() => { expect(h.stat).toHaveBeenCalledTimes(2) })
  background.abort()
  await aborted
  expect(conversionSignal.aborted).toBe(false)
  completed.resolve(result())
  expect(await second).toEqual(result())
  expect(await h.read()).toEqual(result())
  expect(h.convert).toHaveBeenCalledOnce()
  expect(h.stat).toHaveBeenCalledTimes(3)
  await h.cache.dispose()
})

it('rejects stale or unauthorized reuse and never caches a declared conversion failure', async () => {
  const h = harness()
  await h.read()
  h.stat.mockResolvedValue({ ok: true, value: { absolutePath: '/report.docx', version: 'v2' } })
  const failure = { ok: false, error: { message: 'failed' } } as Awaited<ReturnType<ReadOfficeDocument>>
  h.convert.mockResolvedValueOnce(failure).mockResolvedValue(result('v2'))
  expect(await h.read()).toEqual(failure)
  expect(await h.read()).toEqual(result('v2'))
  h.stat.mockResolvedValue(failure)
  expect(await h.read()).toEqual(failure)
  expect(h.convert).toHaveBeenCalledTimes(3)
  await h.cache.dispose()
})

it('discards a cancelled conversion that finishes late without replacing a newer result', async () => {
  const h = harness()
  const started = Promise.withResolvers<undefined>()
  const late = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementationOnce(() => { started.resolve(undefined); return late.promise })
  const caller = new AbortController()
  const pending = h.read(caller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await started.promise
  caller.abort()
  await rejected
  h.convert.mockResolvedValue(result('v1', 'new'))
  await h.read()
  late.resolve(result('v1', 'old'))
  await late.promise
  expect(await h.read()).toEqual(result('v1', 'new'))
  await h.cache.dispose()
})

it('bounds retained entries and byte storage, and separates Session authorization scopes', async () => {
  const h = harness(1, 8)
  await h.read()
  await h.cache.read({ ...file, sessionId: 's2' as SessionId }, new AbortController().signal)
  await h.read()
  expect(h.convert).toHaveBeenCalledTimes(3)
  h.stat.mockResolvedValue({ ok: true, value: { absolutePath: '/report.docx', version: 'large' } })
  h.convert.mockResolvedValue(result('large', 'x'.repeat(10)))
  await h.read()
  await h.read()
  expect(h.convert).toHaveBeenCalledTimes(5)
  await h.cache.dispose()
})

it('does not retain a conversion whose source changed during conversion', async () => {
  const h = harness()
  h.convert.mockResolvedValue(result('v2'))
  await h.read()
  await h.read()
  expect(h.convert).toHaveBeenCalledTimes(2)
  await h.cache.dispose()
})

it('reuses the borrowed binary PDF at the exact byte budget without copying', async () => {
  const h = harness(2, 4)
  const converted = result()
  h.convert.mockResolvedValue(converted)
  try {
    expect(await h.read()).toBe(converted)
    const cached = await h.read()
    expect(cached).toBe(converted)
    if (!cached.ok || !converted.ok) throw new Error('Expected PDF bytes')
    expect(cached.value.data).toBe(converted.value.data)
    expect(cached.value.data.byteLength).toBe(4)
    expect(h.convert).toHaveBeenCalledOnce()
  } finally { await h.cache.dispose() }
})

it('does not retain a different canonical source even when its version token matches', async () => {
  const h = harness()
  h.convert.mockResolvedValue({ ok: true, value: {
    absolutePath: '/replacement.docx', version: 'v1', offset: 0, eof: true, missingFonts: [], generation: 'renderer' as OfficeToPdfGeneration, data: new Uint8Array([1]),
  } })
  try {
    await h.read()
    await h.read()
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally { await h.cache.dispose() }
})

it('cancels before source authorization and after a delayed stat without starting conversion', async () => {
  const h = harness()
  try {
    await expect(h.read(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.stat).not.toHaveBeenCalled()
    const metadata = Promise.withResolvers<Awaited<ReturnType<typeof h.stat>>>()
    h.stat.mockReturnValue(metadata.promise)
    const caller = new AbortController()
    const pending = h.read(caller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    caller.abort()
    metadata.resolve({ ok: true, value: { absolutePath: '/report.docx', version: 'v1' } })
    await rejected
    expect(h.convert).not.toHaveBeenCalled()
  } finally { await h.cache.dispose() }
})

it.each([new Error('transport'), 'transport'])('retries rejected conversions (%s) and waits for cancelled Host work when disposed', async (failure) => {
  const h = harness()
  const started = Promise.withResolvers<AbortSignal>()
  const completed = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  try {
    h.convert.mockRejectedValueOnce(failure)
    await expect(h.read()).rejects.toMatchObject(failure instanceof Error ? { message: 'transport' } : {
      message: 'Office preview failed', cause: failure,
    })
    h.convert.mockImplementation((_file, signal) => { started.resolve(signal); return completed.promise })
    const pending = h.read()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const signal = await started.promise
    let disposed = false
    const disposing = h.cache.dispose().then(() => { disposed = true })
    await rejected
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    completed.resolve(result())
    await disposing
    await expect(h.read()).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    completed.resolve(result())
    await h.cache.dispose()
  }
})

it('preserves an AbortSignal cancellation reason while waiting for the shared conversion to settle', async () => {
  const h = harness()
  const caller = new AbortController()
  const started = Promise.withResolvers<undefined>()
  const completion = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementation(() => { started.resolve(undefined); return completion.promise })
  const pending = h.read(caller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ message: 'Office preview cancelled', cause: 'left document' })
  try {
    await started.promise
    caller.abort('left document')
    await rejected
  } finally {
    completion.resolve(result())
    await h.cache.dispose()
  }
})

it('clears Client reuse when the Host renderer generation changes', async () => {
  const h = harness()
  try {
    await h.read()
    h.generation.mockResolvedValue({ ok: true, value: ('replacement' as OfficeToPdfGeneration) })
    h.convert.mockResolvedValue(result('v1', 'pdf!', 'replacement'))
    await h.read()
    expect(h.convert).toHaveBeenCalledTimes(2)
    await h.read()
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally { await h.cache.dispose() }
})

it('bounds metadata readers and unsettled conversion RPCs including cancellation teardown', async () => {
  const h = harness(2, 32, 1, 2)
  const entered = Promise.withResolvers<undefined>(), completed = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementationOnce(() => { entered.resolve(undefined); return completed.promise })
  const caller = new AbortController()
  const first = expect(h.read(caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise
  caller.abort()
  await first
  try {
    await expect(h.read()).rejects.toThrow('busy')
    expect(h.convert).toHaveBeenCalledOnce()
  } finally { completed.resolve(result()); await h.cache.dispose() }
})

it('sends foreground intent to the Host when joining an in-flight prewarm', async () => {
  const h = harness()
  const entered = Promise.withResolvers<undefined>(), completed = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementation(() => { entered.resolve(undefined); return completed.promise })
  const prewarm = h.cache.read(file, new AbortController().signal, 'background')
  await entered.promise
  const foreground = h.cache.read(file, new AbortController().signal, 'foreground')
  try {
    await vi.waitFor(() => { expect(h.convert).toHaveBeenCalledTimes(2) })
    expect(h.convert.mock.calls.map(call => call[2])).toEqual(['background', 'foreground'])
  } finally { completed.resolve(result()); await Promise.all([prewarm, foreground]); await h.cache.dispose() }
})

it('counts unresolved renderer metadata against the reader limit and joins it on disposal', async () => {
  const h = harness(2, 32, 8, 1)
  const completed = Promise.withResolvers<{ ok: true; value: ReturnType<typeof OfficeToPdfGeneration> }>()
  h.generation.mockReturnValueOnce(completed.promise)
  const first = expect(h.read()).rejects.toMatchObject({ name: 'AbortError' })
  await expect(h.read()).rejects.toThrow('busy')
  expect(h.generation).toHaveBeenCalledOnce()
  let disposed = false
  const closing = h.cache.dispose().then(() => { disposed = true })
  expect(disposed).toBe(false)
  completed.resolve({ ok: true, value: ('renderer' as OfficeToPdfGeneration) })
  await first
  await closing
  expect(h.stat).not.toHaveBeenCalled()
})

it('passes renderer discovery failures through before source authorization and allows retry', async () => {
  const h = harness()
  const failure = { ok: false, error: new RemoteError('document-render/failed', 'Renderer unavailable', { reason: 'unavailable' }) }
  try {
    h.generation.mockResolvedValueOnce(failure)
    expect(await h.read()).toBe(failure)
    expect(h.stat).not.toHaveBeenCalled()
    expect(h.convert).not.toHaveBeenCalled()
    expect(await h.read()).toEqual(result())
    expect(h.convert).toHaveBeenCalledOnce()
  } finally { await h.cache.dispose() }
})

it('restarts a stale generation query without invalidating the current renderer', async () => {
  const h = harness()
  const current = { ok: true as const, value: ('current' as OfficeToPdfGeneration) }
  const stale = { ok: true as const, value: ('stale' as OfficeToPdfGeneration) }
  const converted = result('v1', 'pdf!', 'current')
  h.convert.mockResolvedValue(converted)
  const firstQuery = Promise.withResolvers<typeof current>()
  const middleQuery = Promise.withResolvers<typeof current>()
  h.generation.mockReturnValueOnce(firstQuery.promise).mockReturnValueOnce(middleQuery.promise).mockResolvedValue(current)
  const earlier = h.read()
  const outdated = h.read()
  const restarted = expect(outdated).resolves.toEqual(converted)
  try {
    expect(await h.read()).toEqual(converted)
    firstQuery.resolve(current)
    expect(await earlier).toEqual(converted)
    middleQuery.resolve(stale)
    await restarted
    expect(await h.read()).toEqual(converted)
    expect(h.stat).toHaveBeenCalledTimes(4)
    expect(h.convert).toHaveBeenCalledOnce()
  } finally {
    firstQuery.resolve(current)
    middleQuery.resolve(stale)
    await h.cache.dispose()
  }
})

it('restarts a pending conversion when a newer renderer generation is accepted', async () => {
  const h = harness()
  const entered = Promise.withResolvers<AbortSignal>()
  const completed = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementationOnce((_file, signal) => {
    signal.addEventListener('abort', () => { completed.reject(signal.reason) }, { once: true })
    entered.resolve(signal)
    return completed.promise
  })
  const previous = h.read()
  const converted = result('v1', 'pdf!', 'replacement')
  const restarted = expect(previous).resolves.toEqual(converted)
  try {
    const signal = await entered.promise
    h.generation.mockResolvedValue({ ok: true, value: ('replacement' as OfficeToPdfGeneration) })
    h.convert.mockResolvedValue(converted)
    expect(await h.read()).toEqual(converted)
    await restarted
    expect(signal.aborted).toBe(true)
    expect(h.convert).toHaveBeenCalledTimes(2)
    await h.read()
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally {
    completed.resolve(result())
    await h.cache.dispose()
  }
})

it('reauthorizes source metadata that completes after the renderer generation changes', async () => {
  const h = harness()
  const entered = Promise.withResolvers<undefined>()
  const metadata = { ok: true, value: { absolutePath: '/report.docx', version: 'v1' } }
  const completed = Promise.withResolvers<typeof metadata>()
  h.stat.mockImplementationOnce(() => { entered.resolve(undefined); return completed.promise })
  const previous = h.read()
  const converted = result('v1', 'pdf!', 'replacement')
  const restarted = expect(previous).resolves.toEqual(converted)
  try {
    await entered.promise
    h.generation.mockResolvedValue({ ok: true, value: ('replacement' as OfficeToPdfGeneration) })
    h.convert.mockResolvedValue(converted)
    expect(await h.read()).toEqual(converted)
    completed.resolve(metadata)
    await restarted
    expect(h.convert).toHaveBeenCalledOnce()
  } finally {
    completed.resolve(metadata)
    await h.cache.dispose()
  }
})

it.each([[1, 32], [8, 1]])('leaves foreground admission available when pending/readers are %i/%i', async (pending, readers) => {
  const h = harness(2, 32, pending, readers)
  try {
    await expect(h.cache.read(file, new AbortController().signal, 'background')).rejects.toThrow('busy')
    expect(h.convert).not.toHaveBeenCalled()
    expect(await h.read()).toEqual(result())
  } finally { await h.cache.dispose() }
})

it.each([[2, 32], [8, 2]])('reserves the final pending/reader slot for foreground promotion with %i/%i', async (pending, readers) => {
  const h = harness(2, 32, pending, readers)
  h.stat.mockImplementation(async (requested: SessionFile) => ({ ok: true, value: { absolutePath: `/${requested.path}`, version: 'v1' } }))
  const entered = Promise.withResolvers<undefined>(), complete = Promise.withResolvers<Awaited<ReturnType<ReadOfficeDocument>>>()
  h.convert.mockImplementation(() => { entered.resolve(undefined); return complete.promise })
  const prewarm = h.cache.read(file, new AbortController().signal, 'background')
  await entered.promise
  let foreground: ReturnType<typeof h.read> | undefined
  try {
    await expect(h.cache.read({ ...file, path: 'other.docx' }, new AbortController().signal, 'background')).rejects.toThrow('busy')
    foreground = h.read()
    await vi.waitFor(() => { expect(h.convert).toHaveBeenCalledTimes(2) })
    expect(h.convert.mock.calls.map(call => call[2])).toEqual(['background', 'foreground'])
  } finally { complete.resolve(result()); await Promise.all([prewarm, foreground]); await h.cache.dispose() }
})

it('reports repeated generation supersession through the localized capacity failure', async () => {
  const h = harness()
  const first = Promise.withResolvers<{ ok: true; value: ReturnType<typeof OfficeToPdfGeneration> }>()
  const retry = Promise.withResolvers<{ ok: true; value: ReturnType<typeof OfficeToPdfGeneration> }>()
  h.generation.mockReturnValueOnce(first.promise)
  const work = expect(h.read()).rejects.toThrow('busy')
  try {
    await h.read()
    h.generation.mockReturnValueOnce(retry.promise)
    first.resolve({ ok: true, value: ('obsolete' as OfficeToPdfGeneration) })
    await vi.waitFor(() => { expect(h.generation).toHaveBeenCalledTimes(3) })
    h.generation.mockResolvedValue({ ok: true, value: ('replacement' as OfficeToPdfGeneration) })
    await h.read()
    retry.resolve({ ok: true, value: ('renderer' as OfficeToPdfGeneration) })
    await work
    expect(h.generation).toHaveBeenCalledTimes(4)
  } finally {
    first.resolve({ ok: true, value: ('renderer' as OfficeToPdfGeneration) })
    retry.resolve({ ok: true, value: ('replacement' as OfficeToPdfGeneration) })
    await h.cache.dispose()
  }
})

it('does not retain a PDF returned by a generation newer than the preceding metadata query', async () => {
  const h = harness()
  const converted = result('v1', 'pdf!', 'replacement')
  h.convert.mockResolvedValue(converted)
  try {
    expect(await h.read()).toBe(converted)
    expect(await h.read()).toBe(converted)
    expect(h.convert).toHaveBeenCalledTimes(2)
  } finally { await h.cache.dispose() }
})
