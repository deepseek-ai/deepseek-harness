/** Directory notifications and disposal through the shared scripted Remote transport. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SupervisedStreamOptions } from '@deepseek-ai/dsh-api-workspace-files/src/client/remote.ts'
import { FakeRemote } from '../../../api/workspace-files/tests/fake-remote.client.ts'
import { createWatch } from '../src/client/face.ts'

const SESSION = 'directory-watch-session' as SessionId
const ROOT = '/work/app'

function mount() {
  const remote = new FakeRemote()
  remote.autoReady = false
  const controller = new AbortController()
  const supervise = vi.spyOn(remote, '$stream')
  // createWatch consumes only the stream supervisor and workspaceFiles.changes.
  const iterator = createWatch(remote as unknown as ClientRemote)(SESSION, ROOT, controller.signal)[Symbol.asyncIterator]()
  onTestFinished(async () => {
    controller.abort()
    const returned = iterator.return?.()
    await remote.dispose()
    await returned
  })
  return { remote, controller, iterator, supervise }
}

describe('createWatch', () => {
  it('opens the requested directory, accepts ready, and forwards changes without accepting them', async () => {
    const h = mount()
    const first = h.iterator.next()
    const watch = await h.remote.waitForChanges(0)
    expect(watch).toMatchObject({ sessionId: SESSION, path: ROOT })
    expect(h.supervise.mock.calls[0]?.[0].name).toBe(`directory ${ROOT}`)
    watch.source.push({ kind: 'ready' })
    await expect(first).resolves.toEqual({ done: false, value: 'ready' })
    expect(h.remote.calls).toEqual(['changes', 'accept'])
    const next = h.iterator.next()
    watch.source.push({ kind: 'change', change: { absolutePath: ROOT, version: 'changed' } })
    await expect(next).resolves.toEqual({ done: false, value: 'change' })
    expect(h.remote.calls).toEqual(['changes', 'accept'])
    await h.iterator.return?.()
    expect(watch.source.aborted).toBe(true)
  })

  it('does not create a stream for an already-cancelled node', async () => {
    const h = mount()
    h.controller.abort()
    await expect(h.iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(h.supervise).not.toHaveBeenCalled()
    expect(h.remote.opened).toEqual([])
  })

  it.each([false, true])('classifies a normal stream end after ready=%s and disposes it', async (ready) => {
    const h = mount()
    const first = h.iterator.next()
    const watch = await h.remote.waitForChanges(0)
    const options = h.supervise.mock.calls[0]![0]
    const ended = vi.spyOn(options, 'ended')
    let pending = first
    if (ready) {
      watch.source.push({ kind: 'ready' })
      await expect(first).resolves.toEqual({ done: false, value: 'ready' })
      pending = h.iterator.next()
    }
    const rejected = expect(pending).rejects.toThrow(`Directory watch ended: ${ROOT}`)
    watch.source.end()
    await rejected
    expect(ended).toHaveBeenCalledExactlyOnceWith(ready)
    expect(h.remote.disposed).toEqual([`directory ${ROOT}`])
    expect(watch.source.aborted).toBe(true)
  })

  it('awaits disposal on consumer return and removes the node abort listener', async () => {
    const h = mount()
    const gate = h.remote.holdDisposal()
    const first = h.iterator.next()
    const watch = await h.remote.waitForChanges(0)
    watch.source.push({ kind: 'ready' })
    await first
    const result = h.supervise.mock.results[0]
    if (result?.type !== 'return') throw new Error('expected a supervised stream')
    const dispose = vi.spyOn(result.value, 'dispose')
    let closed = false
    const closing = h.iterator.return!().then((value) => { closed = true; return value })
    try {
      await h.remote.waitForDispose(0)
      expect(closed).toBe(false)
      expect(watch.source.aborted).toBe(true)
      gate.resolve(undefined)
      await expect(closing).resolves.toEqual({ done: true, value: undefined })
      expect(dispose).toHaveBeenCalledTimes(1)
      h.controller.abort()
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve(undefined)
      await closing
    }
  })

  it('does not yield a frame delivered after the node cancels', async () => {
    const h = mount()
    const supervise = FakeRemote.prototype.$stream.bind(h.remote)
    const pulled = Promise.withResolvers<undefined>()
    const deliver = Promise.withResolvers<undefined>()
    h.supervise.mockImplementation(function<Item>(options: SupervisedStreamOptions<Item>) {
      const stream = supervise(options)
      return {
        dispose: () => stream.dispose(),
        async *[Symbol.asyncIterator]() {
          for await (const item of stream) {
            pulled.resolve(undefined)
            await deliver.promise
            yield item
          }
        },
      }
    })
    const pending = h.iterator.next()
    try {
      const watch = await h.remote.waitForChanges(0)
      watch.source.push({ kind: 'ready' })
      await pulled.promise
      h.controller.abort()
      await h.remote.waitForDispose(0)
      deliver.resolve(undefined)
      await expect(pending).resolves.toEqual({ done: true, value: undefined })
      expect(h.remote.calls).toEqual(['changes'])
      expect(watch.source.aborted).toBe(true)
    } finally {
      deliver.resolve(undefined)
    }
  })
})
