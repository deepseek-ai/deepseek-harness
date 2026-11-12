import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForgeLens, ForgeLensFile, ForgeLensFrame, ForgeLensId, ForgeLensInput, ForgeLensResult } from '../src/types.ts'
import { LensCache, LensFailed, lensFrames, LensRegistry, LensWithdrawn, runLens } from '../src/lenses.ts'
import type { LensRegistration, LensSubject } from '../src/lenses.ts'
import { lensVersion } from '../src/lens-version.ts'

afterEach(() => {
  vi.useRealTimers()
})

const limits = { timeoutMs: 1_000, maxReadBytes: 64, maxResultBytes: 1_024 }

function file(path: string, overrides: Partial<ForgeLensFile> = {}): ForgeLensFile {
  return { path, previousPath: null, status: 'modified', binary: false, layer: 'implementation', hunks: [], digest: `d-${path}`, ...overrides }
}

function lens(classify: (input: ForgeLensInput, signal: AbortSignal) => Promise<ForgeLensResult>, id = 'test/lens'): ForgeLens {
  return { id: id as ForgeLensId, version: '1', classify }
}

function subject(files: readonly ForgeLensFile[], read: LensSubject['read'] = async (side, target) => `${side}:${target.path}`): LensSubject {
  return { source: { kind: 'local', scope: { kind: 'unstaged' } }, files, read }
}

/** Register `target` and return its registration and disposer. */
function registered(target: ForgeLens): { registry: LensRegistry; registration: LensRegistration; dispose: () => Promise<void> } {
  const registry = new LensRegistry()
  const dispose = registry.add(target)
  const registration = registry.get(target.id)
  if (registration === undefined) throw new Error('not registered')
  return { registry, registration, dispose }
}

async function collect(frames: AsyncIterable<ForgeLensFrame>): Promise<ForgeLensFrame[]> {
  const list: ForgeLensFrame[] = []
  for await (const frame of frames) list.push(frame)
  return list
}

describe('LensRegistry', () => {
  it('refuses a second registration of one identity and frees it once the first ends', async () => {
    const registry = new LensRegistry()
    const first = lens(async () => ({ files: {} }))
    const dispose = registry.add(first)
    expect(() => registry.add(lens(async () => ({ files: {} })))).toThrow('forge-panel: a lens "test/lens" is already registered')
    expect(registry.get('test/lens')?.lens).toBe(first)
    await dispose()
    expect(registry.get('test/lens')).toBeUndefined()
    await registry.add(first)()
  })

  it('streams the identities after each change, collapsing changes a busy reader missed, until the registry closes', async () => {
    const registry = new LensRegistry()
    const controller = new AbortController()
    const iterator = registry.follow(controller.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: [] })
    const a = registry.add(lens(async () => ({ files: {} }), 'a'))
    registry.add({ ...lens(async () => ({ files: {} }), 'b'), version: '2' })
    await expect(iterator.next()).resolves.toEqual({ done: false, value: [{ id: 'a', version: '1' }, { id: 'b', version: '2' }] })
    await a()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: [{ id: 'b', version: '2' }] })
    const waiting = iterator.next()
    registry.close()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })

    const stopped = registry.follow(controller.signal)[Symbol.asyncIterator]()
    await expect(stopped.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ends a follow stream when its own signal aborts', async () => {
    const registry = new LensRegistry()
    const controller = new AbortController()
    const iterator = registry.follow(controller.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const waiting = iterator.next()
    controller.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })

  it('aborts a running classification when its registration ends and waits until the lens itself settles', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const cleanup = Promise.withResolvers<undefined>()
    const steps: string[] = []
    const { registration, dispose } = registered(lens(async (_input, signal) => {
      started.resolve(signal)
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
      await cleanup.promise
      steps.push('lens settled')
      throw new Error('stopped')
    }))
    const run = runLens(registration, subject([]), limits, new AbortController().signal, () => {})
    const signal = await started.promise
    const disposed = dispose().then(() => { steps.push('disposed') })
    // The caller hears of the withdrawal at once; the disposer waits for the lens's own cleanup.
    await expect(run).rejects.toBeInstanceOf(LensWithdrawn)
    expect(signal.aborted).toBe(true)
    expect(steps).toEqual([])
    cleanup.resolve(undefined)
    await disposed
    expect(steps).toEqual(['lens settled', 'disposed'])
  })
})

describe('runLens', () => {
  it('passes the source, files, and reader, and keeps only paths of the diff', async () => {
    const files = [file('a.ts'), file('b.ts', { status: 'added' })]
    const { registration } = registered(lens(async (input) => {
      expect(input.source).toEqual({ kind: 'local', scope: { kind: 'unstaged' } })
      expect(input.files).toBe(files)
      expect(await input.text('new', 'a.ts', new AbortController().signal)).toBe('new:a.ts')
      return { files: { 'a.ts': { ranges: { old: [], new: [{ start: 1, end: 2 }] } }, 'gone.ts': {} } }
    }))
    await expect(runLens(registration, subject(files), limits, new AbortController().signal, () => {}))
      .resolves.toEqual({ 'a.ts': { ranges: { old: [], new: [{ start: 1, end: 2 }] } } })
  })

  it('refuses a path outside the diff and counts no text for a missing side', async () => {
    const { registration } = registered(lens(async (input) => {
      await expect(input.text('old', 'other.ts', new AbortController().signal)).rejects.toThrow('"other.ts" is not a file of this diff')
      for (let index = 0; index < 100; index += 1) expect(await input.text('old', 'a.ts', new AbortController().signal)).toBeNull()
      return { files: { 'a.ts': {} } }
    }))
    await expect(runLens(registration, subject([file('a.ts')], async () => null), limits, new AbortController().signal, () => {}))
      .resolves.toEqual({ 'a.ts': {} })
  })

  it('fails once the reads exceed the budget, even when the lens swallows the refusal', async () => {
    const text = 'x'.repeat(40)
    const reads: string[] = []
    const greedy = registered(lens(async (input) => {
      reads.push(String(await input.text('new', 'a.ts', new AbortController().signal)))
      await input.text('new', 'a.ts', new AbortController().signal)
      return { files: {} }
    }))
    await expect(runLens(greedy.registration, subject([file('a.ts')], async () => text), limits, new AbortController().signal, () => {}))
      .rejects.toThrow(new LensFailed('the lens read more than maxLensReadBytes (64 bytes) of file text'))
    expect(reads).toEqual([text])

    const swallowing = registered(lens(async (input) => {
      await input.text('new', 'a.ts', new AbortController().signal)
      await input.text('new', 'a.ts', new AbortController().signal).catch(() => null)
      await expect(input.text('new', 'a.ts', new AbortController().signal)).rejects.toBeInstanceOf(LensFailed)
      return { files: {} }
    }))
    await expect(runLens(swallowing.registration, subject([file('a.ts')], async () => text), limits, new AbortController().signal, () => {}))
      .rejects.toBeInstanceOf(LensFailed)
  })

  it('fails a lens that runs past the deadline even when it ignores its signal', async () => {
    vi.useFakeTimers()
    const { registration } = registered(lens(async () => await new Promise<never>(() => {})))
    const run = runLens(registration, subject([]), limits, new AbortController().signal, () => {})
    const outcome = expect(run).rejects.toThrow(new LensFailed('the lens ran past lensTimeoutMs (1000 ms)'))
    await vi.advanceTimersByTimeAsync(1_000)
    await outcome
  })

  it('names the cause of a rejected lens, including a thrown value that is not an error and a synchronous throw', async () => {
    const failing = registered(lens(async () => { throw new Error('parser crashed') }))
    await expect(runLens(failing.registration, subject([]), limits, new AbortController().signal, () => {}))
      .rejects.toThrow(new LensFailed('the lens failed: parser crashed'))
    const odd = registered(lens(async () => { throw 'nope' }))
    await expect(runLens(odd.registration, subject([]), limits, new AbortController().signal, () => {}))
      .rejects.toThrow(new LensFailed('the lens failed: nope'))
    const sync = registered({ id: 'sync' as ForgeLensId, version: '1', classify: () => { throw new Error('at once') } })
    await expect(runLens(sync.registration, subject([]), limits, new AbortController().signal, () => {}))
      .rejects.toThrow(new LensFailed('the lens failed: at once'))
  })

  it('fails a result over the bound', async () => {
    const { registration } = registered(lens(async () => ({ files: { 'a.ts': { ranges: { old: [], new: Array.from({ length: 100 }, (_v, start) => ({ start, end: start })) } } } })))
    await expect(runLens(registration, subject([file('a.ts')]), limits, new AbortController().signal, () => {}))
      .rejects.toThrow(new LensFailed('the lens result exceeds maxCachedLensBytes (1024 bytes)'))
  })

  it('does not start a lens whose registration ended or whose caller left before the run', async () => {
    const classify = vi.fn(async () => ({ files: {} }))
    const withdrawn = registered(lens(classify))
    await withdrawn.dispose()
    await expect(runLens(withdrawn.registration, subject([]), limits, new AbortController().signal, () => {}))
      .rejects.toBeInstanceOf(LensWithdrawn)
    const live = registered(lens(classify))
    await expect(runLens(live.registration, subject([]), limits, AbortSignal.abort(new Error('reader left')), () => {}))
      .rejects.toThrow('reader left')
    expect(classify).not.toHaveBeenCalled()
  })

  it('rethrows the caller\'s reason and stops reporting progress once the caller aborts', async () => {
    const controller = new AbortController()
    const progress = vi.fn()
    const reported = Promise.withResolvers<ForgeLensInput>()
    const { registration } = registered(lens(async (input) => {
      input.progress(1, 2)
      reported.resolve(input)
      return await new Promise<never>(() => {})
    }))
    const run = runLens(registration, subject([]), limits, controller.signal, progress)
    const input = await reported.promise
    controller.abort(new Error('reader left'))
    await expect(run).rejects.toThrow('reader left')
    input.progress(2, 2)
    expect(progress.mock.calls).toEqual([[1, 2]])
  })
})

describe('lensFrames', () => {
  it('yields the latest progress since the previous frame, then the result', async () => {
    const step = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const frames = lensFrames(async (progress) => {
      progress(1, 3)
      progress(2, 3)
      await step.promise
      progress(3, 3)
      await finish.promise
      return { 'a.ts': {} }
    })[Symbol.asyncIterator]()
    await expect(frames.next()).resolves.toEqual({ done: false, value: { kind: 'progress', done: 2, total: 3 } })
    step.resolve(undefined)
    await expect(frames.next()).resolves.toEqual({ done: false, value: { kind: 'progress', done: 3, total: 3 } })
    finish.resolve(undefined)
    await expect(frames.next()).resolves.toEqual({ done: false, value: { kind: 'result', files: { 'a.ts': {} } } })
    await expect(frames.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('drops progress reported as the run finishes and passes a failure on', async () => {
    await expect(collect(lensFrames(async (progress) => {
      progress(1, 1)
      return {}
    }))).resolves.toEqual([{ kind: 'result', files: {} }])
    await expect(collect(lensFrames(async () => { throw new LensFailed('broken') }))).rejects.toThrow('broken')
  })
})

describe('LensCache', () => {
  it('keeps results up to its bound, dropping the least recently used and replacing equal keys', () => {
    const one = { 'a.ts': {} }
    const size = Buffer.byteLength(JSON.stringify(one))
    const cache = new LensCache(size * 2)
    cache.set('a', one)
    cache.set('b', { 'b.ts': {} })
    expect(cache.get('a')).toBe(one)
    cache.set('c', { 'c.ts': {} })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(one)
    const replaced = { 'c.ts': {} }
    cache.set('c', replaced)
    expect(cache.get('c')).toBe(replaced)
    expect(cache.get('a')).toBe(one)
  })
})

describe('lensVersion', () => {
  it('changes with any path, digest, or order and is stable otherwise', () => {
    const files = [{ path: 'a.ts', digest: '1' }, { path: 'b.ts', digest: '2' }]
    expect(lensVersion(files)).toBe(lensVersion([...files]))
    expect(lensVersion(files)).toMatch(/^[0-9a-f]{14}$/)
    expect(new Set([
      lensVersion(files), lensVersion([...files].reverse()), lensVersion([{ path: 'a.ts', digest: '3' }, files[1]!]),
      lensVersion([{ path: 'a.t', digest: 's1' }, files[1]!]), lensVersion([]),
    ]).size).toBe(5)
  })
})
