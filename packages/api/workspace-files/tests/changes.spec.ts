/** Target-scoped Host changes, fresh filesystem metadata, and watcher ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock, MockInstance } from 'vitest'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { WorkspaceFiles } from '../src/index.ts'
import { failureOf, openWorkspace, type Harness } from './harness.ts'

let harness: Harness
let watch: MockInstance<FileSystem['watch']>
let unwatch: Mock<() => Promise<void>>
const cleanups: Array<() => Promise<unknown>> = []

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-changes-')
  unwatch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  watch = vi.spyOn(harness.ctx.fs, 'watch').mockResolvedValue(unwatch)
})

afterEach(async () => {
  try {
    const failures: unknown[] = []
    for (const close of cleanups.splice(0).reverse()) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Change-stream cleanup failed')
  } finally {
    try {
      await harness.dispose()
    } finally {
      vi.restoreAllMocks()
    }
  }
})

/** Emit an instrumented observation without changing the file it describes. */
async function observe(path: string, observation: FsObservation): Promise<void> {
  const target = await harness.ctx.fs.resolve(path)
  harness.ctx.emit('fs/observed', target, observation, undefined)
}

const present = (version: string): FsObservation => ({ kind: 'present', version: FsVersion(version) })

/** Own the iterator until its asynchronous watcher close has settled, including failed assertions. */
function open(
  service: WorkspaceFiles,
  path: string,
  controller = new AbortController(),
) {
  const iterator = service.changes(harness.scope, path, controller.signal)[Symbol.asyncIterator]()
  const close = async (): Promise<void> => {
    controller.abort()
    await iterator.return?.()
  }
  cleanups.push(close)
  return { next: () => iterator.next(), return: () => iterator.return?.(), close, controller }
}

async function ready(stream: ReturnType<typeof open>): Promise<void> {
  await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
}

/** Give disposal cases an independently unloadable service owner. */
async function ownedEndpoint() {
  let service: WorkspaceFiles | undefined
  const fiber = await harness.ctx.plugin(Object.assign((ctx: Context) => {
    service = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 10, maxEntries: 10 })
  }, { inject: ['fs', 'sandboxPolicy'] }))
  cleanups.push(() => fiber.dispose())
  if (service === undefined) throw new Error('plugin body did not run')
  return { service, dispose: () => fiber.dispose() }
}

describe('workspaceFiles.changes — target frames', () => {
  it('acknowledges readiness before draining target observations queued during root resolution', async () => {
    const path = join(harness.workspace, 'early.txt')
    await writeFile(path, 'current contents')
    const service = harness.endpoint()
    const current = await service.stat(harness.scope, path, new AbortController().signal)
    const fs = harness.ctx.fs
    const resolve = fs.resolve.bind(fs)
    const root = await resolve(harness.workspace)
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(fs, 'resolve').mockImplementation(async (requested, options) => {
      if (requested !== harness.workspace) return resolve(requested, options)
      entered.resolve(options?.signal)
      await release.promise
      options?.signal?.throwIfAborted()
      return root
    })
    const stream = open(service, path)
    const acknowledged = vi.fn()
    const first = stream.next().then((result) => { acknowledged(); return result })
    try {
      const lifetime = await entered.promise
      expect(lifetime).toBeInstanceOf(AbortSignal)
      expect(lifetime?.aborted).toBe(false)
      await observe(path, present('old-observation'))
      await observe(path, { kind: 'absent' })
      expect(acknowledged).not.toHaveBeenCalled()
      expect(watch).not.toHaveBeenCalled()
      release.resolve(undefined)
      await expect(first).resolves.toEqual({ done: false, value: { kind: 'ready' } })
      for (let index = 0; index < 2; index++) {
        await expect(stream.next()).resolves.toEqual({
          done: false,
          value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
        })
      }
    } finally {
      release.resolve(undefined)
    }
  })

  it('waits for watcher readiness and retains invalidations delivered during initialization', async () => {
    const path = join(harness.workspace, 'initializing.txt')
    await writeFile(path, 'ready contents')
    const service = harness.endpoint()
    const current = await service.stat(harness.scope, path, new AbortController().signal)
    const entered = Promise.withResolvers<(error?: Error) => void>()
    const release = Promise.withResolvers<undefined>()
    watch.mockImplementationOnce(async (_target, changed) => {
      entered.resolve(changed)
      await release.promise
      return unwatch
    })
    const stream = open(service, path)
    const acknowledged = vi.fn()
    const first = stream.next().then((result) => { acknowledged(); return result })
    try {
      const changed = await entered.promise
      changed()
      expect(acknowledged).not.toHaveBeenCalled()
      release.resolve(undefined)
      await expect(first).resolves.toEqual({ done: false, value: { kind: 'ready' } })
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
      })
    } finally {
      release.resolve(undefined)
    }
  })

  it('filters unrelated target keys, including matching display paths, before stat', async () => {
    const path = join(harness.workspace, 'selected.txt')
    await writeFile(path, 'selected')
    const service = harness.endpoint()
    const current = await service.stat(harness.scope, path, new AbortController().signal)
    const fs = harness.ctx.fs
    const target = await fs.resolve(path)
    const stream = open(service, path)
    await ready(stream)
    const stat = vi.spyOn(fs, 'stat')
    const pending = stream.next()
    for (const unrelated of [join(harness.workspace, 'other.txt'), join(harness.outside, 'secret.txt')]) {
      const other = await fs.resolve(unrelated)
      const inspected = Promise.withResolvers<undefined>()
      // Observing the key read keeps cancellation from hiding an undrained invalidation.
      const observationTarget: FsTarget = {
        displayPath: target.displayPath,
        get targetKey() { inspected.resolve(undefined); return other.targetKey },
      }
      harness.ctx.emit('fs/observed', observationTarget, present('unrelated'), undefined)
      await inspected.promise
      expect(stat).not.toHaveBeenCalled()
    }
    harness.ctx.emit('fs/observed', { ...target, displayPath: 'another display path' }, present('stale'), undefined)
    await expect(pending).resolves.toEqual({
      done: false,
      value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
    })
    expect(stat).toHaveBeenCalledExactlyOnceWith(target, watch.mock.calls[0]![2])
  })

  it.each([present('stale-version'), { kind: 'absent' } satisfies FsObservation])(
    'reads current metadata after a $kind observation',
    async (observation) => {
      const path = join(harness.workspace, 'fresh.txt')
      await writeFile(path, 'fresh bytes')
      const service = harness.endpoint()
      const current = await service.stat(harness.scope, path, new AbortController().signal)
      const stream = open(service, 'fresh.txt')
      await ready(stream)
      const pending = stream.next()
      await observe(path, observation)
      await expect(pending).resolves.toEqual({
        done: false,
        value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
      })
    },
  )

  it('reports absence when stat finds no file despite a present observation', async () => {
    const path = join(harness.workspace, 'gone.txt')
    const target = await harness.ctx.fs.resolve(path)
    const stream = open(harness.endpoint(), path)
    await ready(stream)
    const pending = stream.next()
    await observe(path, present('formerly-present'))
    await expect(pending).resolves.toEqual({
      done: false,
      value: { kind: 'change', change: { absolutePath: harness.ctx.fs.processPath(target), absent: true } },
    })
  })

  it('stats each queued invalidation when pulled instead of replaying its observed version', async () => {
    const path = join(harness.workspace, 'queued.txt')
    await writeFile(path, 'first')
    const service = harness.endpoint()
    const stream = open(service, path)
    await ready(stream)
    await observe(path, present('queued-one'))
    await observe(path, present('queued-two'))
    const first = await service.stat(harness.scope, path, stream.controller.signal)
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { kind: 'change', change: { absolutePath: first.absolutePath, version: first.version } },
    })
    await writeFile(path, 'a longer second version')
    const second = await service.stat(harness.scope, path, stream.controller.signal)
    expect(second.version).not.toBe(first.version)
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { kind: 'change', change: { absolutePath: second.absolutePath, version: second.version } },
    })
  })

  it('keeps another generation of the same target live after one leaves', async () => {
    const path = join(harness.workspace, 'shared.txt')
    await writeFile(path, 'shared')
    const service = harness.endpoint()
    const current = await service.stat(harness.scope, path, new AbortController().signal)
    const one = open(service, path)
    const two = open(service, path)
    await ready(one)
    await ready(two)
    const first = one.next()
    const second = two.next()
    await observe(path, present('outdated'))
    const expected = {
      done: false,
      value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
    }
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
    await one.close()
    expect(unwatch).toHaveBeenCalledTimes(1)
    const later = two.next()
    await observe(path, { kind: 'absent' })
    await expect(later).resolves.toEqual(expected)
    await expect(one.next()).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('workspaceFiles.changes — backends and access', () => {
  it('reports unsupported watching as a Remote error without preventing file reads', async () => {
    const unsupported = new Error('Remote watch is unavailable')
    watch.mockImplementation(() => { throw unsupported })
    const path = join(harness.workspace, 'remote.txt')
    await writeFile(path, 'still readable')
    const service = harness.endpoint()
    const stream = open(service, path)
    await expect(failureOf(stream.next())).resolves.toEqual({
      code: 'workspace-file/watch-unsupported', details: { path },
    })
    await expect(service.read(harness.scope, path, {}, stream.controller.signal)).resolves.toMatchObject({
      text: 'still readable', eof: true,
    })
    await writeFile(path, 'readable after an instrumented write')
    await observe(path, present('stale'))
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(service.read(harness.scope, path, {}, stream.controller.signal)).resolves.toMatchObject({
      text: 'readable after an instrumented write', eof: true,
    })
    await stream.close()
    expect(unwatch).not.toHaveBeenCalled()
  })

  it.each([
    Object.assign(new Error('Watch permission denied'), { code: 'FS_PERMISSION_DENIED' }),
    new Error('Watch initialization failed'),
    'Provider rejected watch initialization',
  ])('reports watcher initialization failure as unavailable: %s', async (failure) => {
    watch.mockRejectedValueOnce(failure)
    const stream = open(harness.endpoint(), harness.workspace)
    await expect(stream.next()).rejects.toMatchObject({
      code: 'workspace-file/watch-unsupported',
      message: typeof failure === 'string' ? failure : failure.message,
      details: { path: harness.workspace },
    })
    expect(unwatch).not.toHaveBeenCalled()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('reports a watcher callback failure and awaits its close', async () => {
    const stream = open(harness.endpoint(), harness.workspace)
    await ready(stream)
    const pending = stream.next()
    const failure = new Error('Watch failed after readiness')
    watch.mock.calls[0]![1](failure)
    await expect(pending).rejects.toBe(failure)
    expect(unwatch).toHaveBeenCalledTimes(1)
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('reports failed watcher initialization without treating it as caller cancellation', async () => {
    const entered = Promise.withResolvers<(error?: Error) => void>()
    const release = Promise.withResolvers<undefined>()
    watch.mockImplementationOnce(async (_target, changed, signal) => {
      entered.resolve(changed)
      await release.promise
      signal.throwIfAborted()
      return unwatch
    })
    const stream = open(harness.endpoint(), harness.workspace)
    const first = stream.next()
    const failure = new Error('Watch failed before readiness')
    try {
      const changed = await entered.promise
      changed(failure)
      expect(stream.controller.signal.aborted).toBe(false)
      release.resolve(undefined)
      await expect(first).rejects.toMatchObject({
        code: 'workspace-file/watch-unsupported', message: failure.message, details: { path: harness.workspace },
      })
      expect(unwatch).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
    }
  })

  it('awaits the acquired watcher close before reporting an initialization callback failure', async () => {
    const failure = new Error('Watch failed before returning its close function')
    watch.mockImplementationOnce(async (_target, changed) => {
      changed(failure)
      return unwatch
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    unwatch.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const stat = vi.spyOn(harness.ctx.fs, 'stat')
    const stream = open(harness.endpoint(), harness.workspace)
    const settled = vi.fn()
    const first = stream.next()
    const settlement = first.then(settled, settled)
    try {
      await entered.promise
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      expect(stream.controller.signal.aborted).toBe(false)
      expect(stat).toHaveBeenCalledExactlyOnceWith(watch.mock.calls[0]![0], watch.mock.calls[0]![2])
      release.resolve(undefined)
      await expect(first).rejects.toMatchObject({
        code: 'workspace-file/watch-unsupported', message: failure.message, details: { path: harness.workspace },
      })
      await settlement
      expect(settled).toHaveBeenCalledTimes(1)
      expect(unwatch).toHaveBeenCalledTimes(1)
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    } finally {
      release.resolve(undefined)
    }
  })

  it('rejects an outside directory before opening a watcher', async () => {
    const stream = open(harness.endpoint(), harness.outside)
    await expect(failureOf(stream.next())).resolves.toEqual({
      code: 'workspace-file/outside-workspace', details: { path: harness.outside },
    })
    expect(watch).not.toHaveBeenCalled()
  })

  it('allows an outside file under the same read authority', async () => {
    const path = join(harness.outside, 'allowed.txt')
    await writeFile(path, 'outside contents')
    const service = harness.endpoint()
    const current = await service.stat(harness.scope, path, new AbortController().signal)
    const stream = open(service, path)
    await ready(stream)
    expect(watch.mock.calls[0]![0]).toEqual(await harness.ctx.fs.resolve(path))
    const pending = stream.next()
    await observe(path, present('outdated'))
    await expect(pending).resolves.toEqual({
      done: false,
      value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
    })
    await expect(service.read(harness.scope, path, {}, stream.controller.signal)).resolves.toMatchObject({
      text: 'outside contents', eof: true,
    })
  })

  it('rejects and closes an outside target when a later stat finds a directory', async () => {
    const path = join(harness.outside, 'changed-kind')
    await writeFile(path, 'initial file')
    const stat = vi.spyOn(harness.ctx.fs, 'stat')
    const stream = open(harness.endpoint(), path)
    await ready(stream)
    const [target, changed, signal] = watch.mock.calls[0]!
    expect(stat).toHaveBeenCalledExactlyOnceWith(target, signal)
    await rm(path)
    await mkdir(path)
    const pending = stream.next()
    changed()
    await expect(failureOf(pending)).resolves.toEqual({
      code: 'workspace-file/outside-workspace', details: { path },
    })
    expect(stat.mock.calls).toEqual([[target, signal], [target, signal]])
    expect(unwatch).toHaveBeenCalledTimes(1)
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('observes creation of a missing outside file through the real local watcher', async () => {
    watch.mockRestore()
    const path = join(harness.outside, 'created.txt')
    const staging = join(harness.outside, 'staged.txt')
    // Publish complete bytes so an early watcher stat cannot observe a partial write.
    await writeFile(staging, 'new file contents')
    const service = harness.endpoint()
    const stream = open(service, path)
    await ready(stream)
    const pending = stream.next()
    await rename(staging, path)
    const current = await service.stat(harness.scope, path, stream.controller.signal)
    await expect(pending).resolves.toEqual({
      done: false,
      value: { kind: 'change', change: { absolutePath: current.absolutePath, version: current.version } },
    })
    await stream.close()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it.each(['create', 'modify', 'remove'] as const)(
    'reports an external direct-child %s through the real local watcher',
    async (operation) => {
      watch.mockRestore()
      const path = join(harness.workspace, 'child.txt')
      if (operation !== 'create') await writeFile(path, 'before')
      await mkdir(join(harness.workspace, 'collapsed'))
      const service = harness.endpoint()
      const target = await harness.ctx.fs.resolve(harness.workspace)
      const observed = vi.fn()
      const detach = harness.ctx.on('fs/observed', observed)
      cleanups.push(async () => { detach() })
      const stream = open(service, harness.workspace)
      await ready(stream)
      const pending = stream.next()
      if (operation === 'remove') await rm(path)
      else await writeFile(path, 'after external mutation')
      const info = await harness.ctx.fs.stat(target)
      expect(info?.type).toBe('directory')
      await expect(pending).resolves.toEqual({
        done: false,
        value: {
          kind: 'change',
          change: { absolutePath: harness.ctx.fs.processPath(target), version: info?.version },
        },
      })
      const listing = await service.list(harness.scope, harness.workspace, stream.controller.signal)
      expect(listing.entries.map(entry => [entry.name, entry.type])).toEqual(
        operation === 'remove'
          ? [['collapsed', 'directory']]
          : [['child.txt', 'file'], ['collapsed', 'directory']],
      )
      if (operation !== 'remove') {
        await expect(service.read(harness.scope, path, {}, stream.controller.signal)).resolves.toMatchObject({
          text: 'after external mutation', eof: true,
        })
      }
      expect(observed).not.toHaveBeenCalled()
      await stream.close()
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    },
  )
})

describe('workspaceFiles.changes — cancellation and disposal', () => {
  it('does not acknowledge a generation disposed while root resolution is blocked', async () => {
    const fs = harness.ctx.fs
    const resolve = fs.resolve.bind(fs)
    const root = await resolve(harness.workspace)
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(fs, 'resolve').mockImplementationOnce(async (_path, options) => {
      entered.resolve(options?.signal)
      await release.promise
      return root
    })
    const owner = await ownedEndpoint()
    const stream = open(owner.service, harness.workspace)
    const first = stream.next()
    try {
      const lifetime = await entered.promise
      if (lifetime === undefined) throw new Error('Root resolution received no cancellation signal')
      const aborted = Promise.withResolvers<undefined>()
      lifetime.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      const finished = vi.fn()
      const disposal = owner.dispose().then(finished)
      await aborted.promise
      expect(stream.controller.signal.aborted).toBe(false)
      expect(finished).not.toHaveBeenCalled()
      release.resolve(undefined)
      await expect(first).resolves.toEqual({ done: true, value: undefined })
      await disposal
      expect(finished).toHaveBeenCalledTimes(1)
      expect(watch).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
    }
  })

  it('refuses an already-aborted signal without acquiring a watcher', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = open(harness.endpoint(), harness.workspace, controller)
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(watch).not.toHaveBeenCalled()
  })

  it('ends an idle generation and closes its watcher on cancellation', async () => {
    const stream = open(harness.endpoint(), harness.workspace)
    await ready(stream)
    const pending = stream.next()
    stream.controller.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'dispose'] as const)('closes a generation paused at ready on %s and awaits watcher closure', async (ending) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    unwatch.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const owner = await ownedEndpoint()
    const stream = open(owner.service, harness.workspace)
    cleanups.push(async () => { release.resolve(undefined) })
    await ready(stream)
    const finished = vi.fn()
    let disposal: Promise<void> | undefined
    try {
      if (ending === 'cancel') {
        stream.controller.abort()
        await entered.promise
        await observe(harness.workspace, present('closing'))
      }
      disposal = owner.dispose().then(finished)
      await entered.promise
      expect(stream.controller.signal.aborted).toBe(ending === 'cancel')
      expect(unwatch).toHaveBeenCalledTimes(1)
      expect(finished).not.toHaveBeenCalled()
      release.resolve(undefined)
      await disposal
      expect(finished).toHaveBeenCalledTimes(1)
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
      expect(unwatch).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(undefined)
      await stream.close()
      if (disposal !== undefined) await disposal
    }
  })

  it('reports watcher-close failures without requiring another pull', async () => {
    const failure = new Error('Watcher close failed')
    const reported = Promise.withResolvers<unknown>()
    const error = vi.spyOn(harness.ctx.logger, 'error').mockImplementation((value) => { reported.resolve(value) })
    cleanups.push(async () => { error.mockRestore() })
    unwatch.mockRejectedValueOnce(failure)
    const stream = open(harness.endpoint(), harness.workspace)
    await ready(stream)
    stream.controller.abort()
    await expect(reported.promise).resolves.toBe(failure)
    await expect(stream.next()).rejects.toBe(failure)
    expect(unwatch).toHaveBeenCalledOnce()
  })

  it('drops queued invalidations when cancelled after ready and before another pull', async () => {
    const stream = open(harness.endpoint(), harness.workspace)
    await ready(stream)
    await observe(harness.workspace, present('queued'))
    const stat = vi.spyOn(harness.ctx.fs, 'stat')
    stream.controller.abort()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    expect(stat).not.toHaveBeenCalled()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it.each(['root', 'target'] as const)(
    'ends quietly when %s resolution rejects after cancellation',
    async (phase) => {
      const fs = harness.ctx.fs
      const resolve = fs.resolve.bind(fs)
      const path = join(harness.workspace, 'cancelled.txt')
      const entered = Promise.withResolvers<AbortSignal | undefined>()
      const release = Promise.withResolvers<undefined>()
      vi.spyOn(fs, 'resolve').mockImplementation(async (requested, options) => {
        const blocked = phase === 'root' ? harness.workspace : path
        if (requested !== blocked) return resolve(requested, options)
        entered.resolve(options?.signal)
        await release.promise
        options?.signal?.throwIfAborted()
        return resolve(requested, options)
      })
      const stream = open(harness.endpoint(), path)
      const pending = stream.next()
      try {
        const lifetime = await entered.promise
        expect(lifetime?.aborted).toBe(false)
        stream.controller.abort()
        expect(lifetime?.aborted).toBe(true)
        release.resolve(undefined)
        await expect(pending).resolves.toEqual({ done: true, value: undefined })
        expect(watch).not.toHaveBeenCalled()
      } finally {
        release.resolve(undefined)
      }
    },
  )

  it('does not open a watcher after target resolution returns past cancellation', async () => {
    const fs = harness.ctx.fs
    const resolve = fs.resolve.bind(fs)
    const path = join(harness.workspace, 'late-target.txt')
    const target = await resolve(path)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(fs, 'resolve').mockImplementation(async (requested, options) => {
      if (requested !== path) return resolve(requested, options)
      entered.resolve(undefined)
      await release.promise
      return target
    })
    const stream = open(harness.endpoint(), path)
    const pending = stream.next()
    try {
      await entered.promise
      stream.controller.abort()
      release.resolve(undefined)
      await expect(pending).resolves.toEqual({ done: true, value: undefined })
      expect(watch).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
    }
  })

  it.each(['reject', 'return'] as const)(
    'ends quietly when watcher initialization settles by %s after cancellation',
    async (settlement) => {
      const entered = Promise.withResolvers<AbortSignal>()
      const release = Promise.withResolvers<undefined>()
      watch.mockImplementationOnce(async (_target, _changed, signal) => {
        entered.resolve(signal)
        await release.promise
        if (settlement === 'reject') signal.throwIfAborted()
        return unwatch
      })
      const stream = open(harness.endpoint(), harness.workspace)
      const pending = stream.next()
      try {
        const lifetime = await entered.promise
        stream.controller.abort()
        expect(lifetime.aborted).toBe(true)
        release.resolve(undefined)
        await expect(pending).resolves.toEqual({ done: true, value: undefined })
        expect(unwatch).toHaveBeenCalledTimes(settlement === 'return' ? 1 : 0)
      } finally {
        release.resolve(undefined)
      }
    },
  )

  it.each([
    { phase: 'initial', settlement: 'reject' },
    { phase: 'initial', settlement: 'return' },
    { phase: 'change', settlement: 'reject' },
    { phase: 'change', settlement: 'return' },
  ] as const)(
    'ends quietly when $phase stat settles by $settlement after cancellation',
    async ({ phase, settlement }) => {
      const path = join(harness.workspace, 'late-stat.txt')
      await writeFile(path, 'contents')
      const fs = harness.ctx.fs
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      const entered = Promise.withResolvers<AbortSignal | undefined>()
      const release = Promise.withResolvers<undefined>()
      const stream = open(harness.endpoint(), path)
      if (phase === 'change') await ready(stream)
      vi.spyOn(fs, 'stat').mockImplementationOnce(async (_target, signal) => {
        entered.resolve(signal)
        await release.promise
        if (settlement === 'reject') signal?.throwIfAborted()
        return info
      })
      const pending = stream.next()
      try {
        if (phase === 'change') await observe(path, present('trigger'))
        const lifetime = await entered.promise
        stream.controller.abort()
        expect(lifetime?.aborted).toBe(true)
        release.resolve(undefined)
        await expect(pending).resolves.toEqual({ done: true, value: undefined })
        expect(unwatch).toHaveBeenCalledTimes(phase === 'change' ? 1 : 0)
      } finally {
        release.resolve(undefined)
      }
    },
  )

  it.each(['root', 'target'] as const)('surfaces a %s resolution failure unrelated to cancellation', async (phase) => {
    const failure = new Error('Path resolution failed')
    const path = join(harness.workspace, 'unresolved.txt')
    const failedPath = phase === 'root' ? harness.workspace : path
    const resolve = harness.ctx.fs.resolve.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'resolve').mockImplementation(async (requested, options) => {
      if (requested === failedPath) throw failure
      return resolve(requested, options)
    })
    const stat = vi.spyOn(harness.ctx.fs, 'stat')
    const stream = open(harness.endpoint(), path)
    await expect(stream.next()).rejects.toBe(failure)
    expect(stream.controller.signal.aborted).toBe(false)
    expect(watch).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('propagates a non-cancellation stat failure without publishing absence and closes the watcher', async () => {
    const failure = new Error('Metadata read failed')
    const stream = open(harness.endpoint(), harness.workspace)
    await ready(stream)
    const stat = vi.spyOn(harness.ctx.fs, 'stat').mockRejectedValueOnce(failure)
    const pending = stream.next()
    const [target, changed, signal] = watch.mock.calls[0]!
    changed()
    await expect(pending).rejects.toBe(failure)
    expect(stream.controller.signal.aborted).toBe(false)
    expect(stat).toHaveBeenCalledExactlyOnceWith(target, signal)
    expect(unwatch).toHaveBeenCalledTimes(1)
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('awaits asynchronous watcher close when the consumer returns', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    unwatch.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const stream = open(harness.endpoint(), harness.workspace)
    await ready(stream)
    const finished = vi.fn()
    const returned = Promise.resolve(stream.return()).then((result) => { finished(); return result })
    try {
      await entered.promise
      expect(finished).not.toHaveBeenCalled()
      release.resolve(undefined)
      await expect(returned).resolves.toEqual({ done: true, value: undefined })
      watch.mock.calls[0]![1]()
      await observe(harness.workspace, present('late'))
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
      expect(unwatch).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(undefined)
    }
  })

  it('awaits every watcher close on fiber disposal and leaves a new owner live', async () => {
    const path = join(harness.workspace, 'owned.txt')
    await writeFile(path, 'owner contents')
    const fs = harness.ctx.fs
    const target = await fs.resolve(path)
    const info = await fs.stat(target)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let closing = 0
    unwatch.mockImplementation(async () => {
      if (++closing === 2) entered.resolve(undefined)
      await release.promise
    })
    const owner = await ownedEndpoint()
    const one = open(owner.service, path)
    const two = open(owner.service, path)
    await ready(one)
    await ready(two)
    const first = one.next()
    const second = two.next()
    const finished = vi.fn()
    const disposal = owner.dispose().then(finished)
    try {
      await entered.promise
      expect(finished).not.toHaveBeenCalled()
      release.resolve(undefined)
      await expect(first).resolves.toEqual({ done: true, value: undefined })
      await expect(second).resolves.toEqual({ done: true, value: undefined })
      await disposal
      expect(finished).toHaveBeenCalledTimes(1)
      expect(unwatch).toHaveBeenCalledTimes(2)
      const live = open(harness.endpoint(), path)
      await ready(live)
      const stat = vi.spyOn(fs, 'stat')
      const next = live.next()
      watch.mock.calls[0]![1]()
      watch.mock.calls[1]![1]()
      await observe(path, present('new-owner'))
      await expect(next).resolves.toEqual({
        done: false,
        value: {
          kind: 'change',
          change: { absolutePath: fs.processPath(target), version: info?.version },
        },
      })
      expect(stat).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(undefined)
    }
  })
})
