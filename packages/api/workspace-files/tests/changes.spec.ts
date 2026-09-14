/** The `changes` stream: driven by `fs/observed`, filtered by the workspace root, ended by its signal. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsObservation } from '@deepseek-ai/dsh-fs'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { WorkspaceFiles } from '../src/index.ts'
import type { WorkspaceFileWatchFrame } from '../src/types.ts'
import { openWorkspace, type Harness } from './harness.ts'

let harness: Harness
const closeStreams: Array<() => Promise<unknown>> = []

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-changes-')
})

afterEach(async () => {
  try {
    for (const close of closeStreams.splice(0)) await close()
    await harness.dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

/** Emit one observation for `path` the way a tool does after touching it. */
async function observe(path: string, observation: FsObservation): Promise<string> {
  const target = await harness.ctx.fs.resolve(path)
  harness.ctx.emit('fs/observed', target, observation, undefined)
  return harness.ctx.fs.processPath(target)
}

const present = (version: string): FsObservation => ({ kind: 'present', version: FsVersion(version) })

/** Own one generation through abort and iterator completion, including failed assertions. */
function open(
  service: WorkspaceFiles,
  controller = new AbortController(),
): { next(): Promise<IteratorResult<WorkspaceFileWatchFrame>>; controller: AbortController } {
  const iterator = service.changes(harness.scope, controller.signal)[Symbol.asyncIterator]()
  closeStreams.push(async () => {
    controller.abort()
    await iterator.return?.()
  })
  return { next: () => iterator.next(), controller }
}

describe('workspaceFiles.changes — frames', () => {
  it('acknowledges the resolved root before draining observations queued during root resolution', async () => {
    const service = harness.endpoint()
    const fs = harness.ctx.fs
    const original = fs.resolve.bind(fs)
    const root = await original(harness.workspace)
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(fs, 'resolve').mockImplementation(async (path, opts) => {
      if (path !== harness.workspace) return original(path, opts)
      entered.resolve(opts?.signal)
      await release.promise
      opts?.signal?.throwIfAborted()
      return root
    })
    const stream = open(service)
    const first = stream.next()
    let acknowledged = false
    void first.then(() => { acknowledged = true })
    try {
      expect(await entered.promise).toBe(stream.controller.signal)
      const a = await observe(join(harness.workspace, 'early-a.txt'), present('a1'))
      await observe(join(harness.outside, 'secret.txt'), present('outside'))
      const b = await observe(join(harness.workspace, 'early-b.txt'), { kind: 'absent' })
      expect(acknowledged).toBe(false)
      release.resolve(undefined)
      await expect(first).resolves.toEqual({ done: false, value: { kind: 'ready' } })
      await expect(stream.next()).resolves.toEqual({
        done: false, value: { kind: 'change', change: { absolutePath: a, version: 'a1' } },
      })
      await expect(stream.next()).resolves.toEqual({
        done: false, value: { kind: 'change', change: { absolutePath: b, absent: true } },
      })
    } finally {
      release.resolve(undefined)
    }
  })

  it('reports a present observation inside the workspace as its absolute path and version', async () => {
    const stream = open(harness.endpoint())
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const pending = stream.next()
    const absolutePath = await observe(join(harness.workspace, 'a.txt'), present('v1'))
    expect(await pending).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, version: 'v1' } } })
    expect(absolutePath).toBe(harness.ctx.fs.processPath(await harness.ctx.fs.resolve(join(harness.workspace, 'a.txt'))))
  })

  it('reports an absent observation as absent', async () => {
    const stream = open(harness.endpoint())
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const pending = stream.next()
    const absolutePath = await observe(join(harness.workspace, 'gone.txt'), { kind: 'absent' })
    expect(await pending).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, absent: true } } })
  })

  it('drops observations outside the workspace root', async () => {
    const stream = open(harness.endpoint())
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const pending = stream.next()
    await observe(join(harness.outside, 'secret.txt'), present('v1'))
    const absolutePath = await observe(join(harness.workspace, 'seen.txt'), present('v2'))
    expect(await pending).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, version: 'v2' } } })
  })

  it('queues observations made faster than they are pulled, in emission order', async () => {
    const stream = open(harness.endpoint())
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const first = stream.next()
    const a = await observe(join(harness.workspace, 'a.txt'), present('a1'))
    const b = await observe(join(harness.workspace, 'b.txt'), present('b1'))
    expect(await first).toEqual({ done: false, value: { kind: 'change', change: { absolutePath: a, version: 'a1' } } })
    expect(await stream.next()).toEqual({ done: false, value: { kind: 'change', change: { absolutePath: b, version: 'b1' } } })
  })

  it('serves every open generation independently', async () => {
    const service = harness.endpoint()
    const one = open(service)
    const two = open(service)
    await expect(one.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    await expect(two.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const firstOfOne = one.next()
    const firstOfTwo = two.next()
    const absolutePath = await observe(join(harness.workspace, 'a.txt'), present('v1'))
    expect(await firstOfOne).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, version: 'v1' } } })
    expect(await firstOfTwo).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, version: 'v1' } } })
  })
})

describe('workspaceFiles.changes — ending', () => {
  it('does not acknowledge a subscription disposed while its workspace root is resolving', async () => {
    const fs = harness.ctx.fs
    const original = fs.resolve.bind(fs)
    const root = await original(harness.workspace)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(fs, 'resolve').mockImplementation(async (path, opts) => {
      if (path !== harness.workspace) return original(path, opts)
      entered.resolve(undefined)
      await release.promise
      return root
    })
    let service: WorkspaceFiles | undefined
    const fiber = await harness.ctx.plugin(Object.assign((ctx: Context) => {
      service = new WorkspaceFiles(ctx, { maxBytes: 1, maxFileBytes: 1, maxLines: 1, maxEntries: 1 })
    }, { inject: ['fs', 'sandboxPolicy'] }))
    try {
      if (service === undefined) throw new Error('plugin body did not run')
      const stream = open(service)
      const first = stream.next()
      await entered.promise
      await fiber.dispose()
      release.resolve(undefined)
      await expect(first).resolves.toEqual({ done: true, value: undefined })
    } finally {
      release.resolve(undefined)
      await fiber.dispose()
    }
  })

  it('refuses an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = open(harness.endpoint(), controller)
    await expect(stream.next()).rejects.toThrow()
  })

  it('ends when its signal aborts while idle', async () => {
    const stream = open(harness.endpoint())
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const first = stream.next()
    // A delivered frame proves the generation is past setup and waiting idle.
    await observe(join(harness.workspace, 'a.txt'), present('v1'))
    expect((await first).done).toBe(false)
    const pending = stream.next()
    stream.controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('drops queued observations when cancelled after ready but before the next pull', async () => {
    const stream = open(harness.endpoint())
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    await observe(join(harness.workspace, 'queued-before-abort.txt'), present('v1'))
    stream.controller.abort()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ends when its signal aborts during setup, without delivering anything', async () => {
    const stream = open(harness.endpoint())
    const pending = stream.next()
    stream.controller.abort()
    await observe(join(harness.workspace, 'a.txt'), present('v1'))
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('ends when its signal aborts while the root resolves, resolving under that signal', async () => {
    const fs = harness.ctx.fs
    const original = fs.resolve.bind(fs)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    // A backend that checks the signal after its round-trip, as a remote one does.
    const spy = vi.spyOn(fs, 'resolve').mockImplementation(async (path, opts) => {
      await gate
      opts?.signal?.throwIfAborted()
      return original(path, opts)
    })
    const stream = open(harness.endpoint())
    const pending = stream.next()
    stream.controller.abort()
    release()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(spy).toHaveBeenCalledWith(expect.any(String), { signal: stream.controller.signal })
    spy.mockRestore()
  })

  it('ends when its signal aborts between the root resolving and the first pull', async () => {
    const fs = harness.ctx.fs
    const original = fs.resolve.bind(fs)
    const controller = new AbortController()
    // The abort lands after the backend answered and before the drain installs its listener.
    const spy = vi.spyOn(fs, 'resolve').mockImplementation(async (path, opts) => {
      const target = await original(path, opts)
      controller.abort()
      return target
    })
    const stream = open(harness.endpoint(), controller)
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    spy.mockRestore()
  })

  it('surfaces a root that fails to resolve', async () => {
    const spy = vi.spyOn(harness.ctx.fs, 'resolve').mockRejectedValue(new Error('no such root'))
    const stream = open(harness.endpoint())
    await expect(stream.next()).rejects.toThrow('no such root')
    spy.mockRestore()
  })

  it('stops delivering to a generation the consumer returned from', async () => {
    const service = harness.endpoint()
    const controller = new AbortController()
    const iterator = service.changes(harness.scope, controller.signal)[Symbol.asyncIterator]()
    closeStreams.push(async () => {
      controller.abort()
      await iterator.return?.()
    })
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const first = iterator.next()
    const absolutePath = await observe(join(harness.workspace, 'a.txt'), present('v1'))
    expect(await first).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, version: 'v1' } } })
    expect(await iterator.return?.(undefined)).toEqual({ done: true, value: undefined })
    // A later observation reaches no follower: the set is empty again, so the
    // second generation opened here is the only one that sees it.
    const stream = open(service)
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const pending = stream.next()
    const later = await observe(join(harness.workspace, 'b.txt'), present('v2'))
    expect(await pending).toEqual({ done: false, value: { kind: 'change', change: { absolutePath: later, version: 'v2' } } })
  })

  it('ends every open generation when the owning fiber is disposed', async () => {
    let service: WorkspaceFiles | undefined
    const fiber = await harness.ctx.plugin(Object.assign((ctx: Context) => {
      service = new WorkspaceFiles(ctx, { maxBytes: 1, maxFileBytes: 1, maxLines: 1, maxEntries: 1 })
    }, { inject: ['fs', 'sandboxPolicy'] }))
    if (service === undefined) throw new Error('plugin body did not run')
    const stream = open(service)
    await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const first = stream.next()
    await observe(join(harness.workspace, 'a.txt'), present('v0'))
    expect((await first).done).toBe(false)
    const pending = stream.next()
    await fiber.dispose()
    expect(await pending).toEqual({ done: true, value: undefined })
    // The listener left with the fiber: a fresh generation on a live service
    // proves the root context still observes while the disposed one is silent.
    const live = open(harness.endpoint())
    await expect(live.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    const next = live.next()
    const absolutePath = await observe(join(harness.workspace, 'a.txt'), present('v1'))
    expect(await next).toEqual({ done: false, value: { kind: 'change', change: { absolutePath, version: 'v1' } } })
  })
})
