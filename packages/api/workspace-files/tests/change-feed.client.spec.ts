/** Target-scoped Host streams, canonical-path delivery, and follower disposal. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ChangeFeed } from '../src/client/change-feed.ts'
import type { WorkspaceFileWatchFrame } from '../src/types.ts'
import { FakeRemote } from './fake-remote.client.ts'

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId
const PATH = '/w/a.txt'

function harness() {
  const remote = new FakeRemote()
  remote.autoReady = false
  const feed = new ChangeFeed(remote)
  const followers: Array<{ controller: AbortController; it: AsyncIterator<unknown> }> = []
  onTestFinished(async () => {
    for (const follower of followers) follower.controller.abort()
    await remote.dispose()
    await Promise.all(followers.map(follower => Promise.resolve(follower.it.return?.())))
    await feed.settle()
    expect(remote.opened.every(watch => watch.source.aborted)).toBe(true)
  })
  const follow = (sessionId: SessionId, path: string, controller = new AbortController()) => {
    const follower = feed.follow(sessionId, path, controller.signal)
    follower.bind(path)
    const result = { it: follower[Symbol.asyncIterator](), controller, ready: follower.ready }
    followers.push(result)
    return result
  }
  return { remote, feed, follow }
}

describe('ChangeFeed — one Host stream per Session and target', () => {
  it('starts a later follower from the existing target acknowledgement without opening another stream', async () => {
    const { remote, feed, follow } = harness()
    const first = follow(S1, PATH)
    await remote.ready(0)
    await expect(first.ready).resolves.toBe(true)
    const second = follow(S1, PATH)
    await expect(second.ready).resolves.toBe(true)
    expect(remote.calls).toEqual(['changes', 'accept'])
    expect(remote.opened).toMatchObject([{ sessionId: S1, path: PATH }])

    await remote.opened[0]!.source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 'v1' } })
    await expect(second.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    first.controller.abort()
    second.controller.abort()
    await expect(second.it.next()).resolves.toEqual({ done: true, value: undefined })
    await feed.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })

  it('shares a stream only when both Session and target match', async () => {
    const { remote, follow } = harness()
    const one = follow(S1, PATH)
    const twin = follow(S1, PATH)
    const otherPath = follow(S1, '/w/b.txt')
    const otherSession = follow(S2, PATH)
    await Promise.all([remote.ready(0), remote.ready(1), remote.ready(2)])
    await expect(Promise.all([one.ready, twin.ready, otherPath.ready, otherSession.ready])).resolves.toEqual([true, true, true, true])
    expect(remote.opened.map(({ sessionId, path }) => ({ sessionId, path }))).toEqual([
      { sessionId: S1, path: PATH },
      { sessionId: S1, path: '/w/b.txt' },
      { sessionId: S2, path: PATH },
    ])
  })

  it('disposes a target stream when its last follower leaves and reopens for the next', async () => {
    const { remote, feed, follow } = harness()
    const a = follow(S1, PATH)
    const b = follow(S1, PATH)
    const { source } = await remote.ready(0)
    a.controller.abort()
    await expect(a.it.next()).resolves.toEqual({ done: true, value: undefined })
    expect(remote.disposed).toEqual([])
    await source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 'v1' } })
    await expect(b.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    b.controller.abort()
    await feed.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
    expect(source.aborted).toBe(true)
    const next = follow(S1, PATH)
    await remote.ready(1)
    await expect(next.ready).resolves.toBe(true)
    expect(remote.opened).toHaveLength(2)
  })

  it('waits for the same target to close while another target can open, and settle waits for the close', async () => {
    const { remote, feed, follow } = harness()
    const gate = remote.holdDisposal()
    const a = follow(S1, PATH)
    await remote.ready(0)
    a.controller.abort()
    await remote.waitForDispose(0)
    const b = follow(S1, PATH)
    let settled = false
    const closing = feed.settle().then(() => { settled = true })
    const independent = follow(S1, '/w/b.txt')
    const otherWatch = await remote.ready(1)
    await expect(independent.ready).resolves.toBe(true)
    expect(otherWatch.path).toBe('/w/b.txt')
    expect(remote.opened).toHaveLength(2)
    expect(settled).toBe(false)

    gate.resolve(undefined)
    await closing
    await remote.ready(2)
    await expect(b.ready).resolves.toBe(true)
    expect(remote.opened.map(watch => watch.path)).toEqual([PATH, '/w/b.txt', PATH])
    expect(settled).toBe(true)
    await feed.settle()
  })

  it('keeps waiting for the newest close when two closes of one target overlap', async () => {
    const { remote, feed, follow } = harness()
    const firstGate = remote.holdDisposal()
    const a = follow(S1, PATH)
    await remote.ready(0)
    a.controller.abort()
    await remote.waitForDispose(0)
    const b = follow(S1, PATH)
    const secondGate = remote.holdDisposal()
    b.controller.abort()
    await remote.waitForDispose(1)
    await expect(b.ready).resolves.toBe(false)
    let settled = false
    const closing = feed.settle().then(() => { settled = true })
    firstGate.resolve(undefined)
    await remote.waitForStreamEnd(1)
    expect(remote.disposed).toHaveLength(2)
    expect(settled).toBe(false)
    secondGate.resolve(undefined)
    await closing
    expect(settled).toBe(true)
    const next = follow(S1, PATH)
    await remote.ready(2)
    await expect(next.ready).resolves.toBe(true)
    expect(remote.opened).toHaveLength(3)
  })

  it('treats a rejected dispose as settled so the same target can reopen', async () => {
    const { remote, feed, follow } = harness()
    const gate = remote.holdDisposal()
    const a = follow(S1, PATH)
    await remote.ready(0)
    a.controller.abort()
    await remote.waitForDispose(0)
    const b = follow(S1, PATH)
    const independent = follow(S1, '/w/b.txt')
    await remote.ready(1)
    await expect(independent.ready).resolves.toBe(true)
    expect(remote.opened.map(watch => watch.path)).toEqual([PATH, '/w/b.txt'])
    gate.reject(new Error('carrier gone'))
    remote.disposeGate = undefined
    await remote.ready(2)
    await expect(b.ready).resolves.toBe(true)
    expect(remote.opened).toHaveLength(3)
    await feed.settle()
  })
})

describe('ChangeFeed — delivery', () => {
  it('routes only matching canonical paths to shared followers, normalizing Host separators', async () => {
    const { remote, follow } = harness()
    const mine = follow(S1, 'C:/w/a b.txt')
    const twin = follow(S1, 'C:/w/a b.txt')
    const other = follow(S1, 'C:/w/other.txt')
    const { source } = await remote.ready(0)
    const otherWatch = await remote.ready(1)
    await source.deliver({ kind: 'change', change: { absolutePath: 'C:/w/a b.txt', version: 'v1' } })
    await source.deliver({ kind: 'change', change: { absolutePath: 'C:\\w\\a b.txt', absent: true } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'absent' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    mine.controller.abort()
    await source.deliver({ kind: 'change', change: { absolutePath: 'C:/w/other.txt', version: 'wrong-target' } })
    await source.deliver({ kind: 'change', change: { absolutePath: 'C:/w/a b.txt', version: 'v2' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'absent' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v2' } })
    await otherWatch.source.deliver({ kind: 'change', change: { absolutePath: 'C:/w/other.txt', version: 'own-target' } })
    await expect(other.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'own-target' } })
  })

  it('queues frames reported before the consumer starts pulling', async () => {
    const { remote, follow } = harness()
    const mine = follow(S1, PATH)
    const { source } = await remote.ready(0)
    await source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 'v1' } })
    await source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 'v2' } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v2' } })
  })

  it('keeps Sessions apart even when their target paths match', async () => {
    const { remote, follow } = harness()
    const one = follow(S1, PATH)
    const two = follow(S2, PATH)
    const firstWatch = await remote.ready(0)
    const secondWatch = await remote.ready(1)
    await secondWatch.source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 's2-version' } })
    await expect(two.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 's2-version' } })
    await firstWatch.source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 's1-version' } })
    await expect(one.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 's1-version' } })
  })

  it('emits refresh on a later ready for every follower of that target only', async () => {
    const { remote, follow } = harness()
    const one = follow(S1, PATH)
    const twin = follow(S1, PATH)
    const other = follow(S1, '/w/b.txt')
    const { source } = await remote.ready(0)
    const otherWatch = await remote.ready(1)
    await source.deliver({ kind: 'ready' })
    await expect(one.it.next()).resolves.toEqual({ done: false, value: { kind: 'refresh' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'refresh' } })
    await otherWatch.source.deliver({ kind: 'change', change: { absolutePath: '/w/b.txt', version: 'v1' } })
    await expect(other.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    expect(remote.calls).toEqual(['changes', 'changes', 'accept', 'accept', 'accept'])
  })
})

describe('ChangeFeed — a follower ends', () => {
  it('ends every shared follower and disposes the target stream for an unknown wire frame kind', async () => {
    const { remote, feed, follow } = harness()
    const first = follow(S1, PATH)
    const second = follow(S1, PATH)
    const { source } = await remote.ready(0)
    await expect(Promise.all([first.ready, second.ready])).resolves.toEqual([true, true])
    const endings = Promise.all([first.it.next(), second.it.next()])
    // The Remote double supplies decoded wire data, including an unknown protocol tag.
    const wireFrame: unknown = JSON.parse('{"kind":"future-frame"}')
    source.push(wireFrame as WorkspaceFileWatchFrame)
    await expect(endings).resolves.toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ])
    await feed.settle()
    expect(source.aborted).toBe(true)
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
    expect(remote.opened).toHaveLength(1)
  })

  it('ends on its signal and drops nothing queued before it', async () => {
    const { remote, follow } = harness()
    const mine = follow(S1, PATH)
    const { source } = await remote.ready(0)
    await source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 'v1' } })
    mine.controller.abort()
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await expect(mine.it.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('is empty when the signal is already aborted without opening a stream', async () => {
    const { remote, feed, follow } = harness()
    const controller = new AbortController()
    controller.abort()
    const follower = follow(S1, PATH, controller)
    await expect(follower.ready).resolves.toBe(false)
    await expect(follower.it.next()).resolves.toEqual({ done: true, value: undefined })
    await feed.settle()
    expect(remote.opened).toEqual([])
  })

  it('unregisters when the consumer breaks out after a notice', async () => {
    const { remote, feed, follow } = harness()
    const mine = follow(S1, PATH)
    const { source } = await remote.ready(0)
    await source.deliver({ kind: 'change', change: { absolutePath: PATH, version: 'v1' } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await mine.it.return?.()
    await feed.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
    expect(source.aborted).toBe(true)
  })

  it('ends shared followers when the Host closes their target stream without ending other targets', async () => {
    const { remote, feed, follow } = harness()
    const a = follow(S1, PATH)
    const b = follow(S1, PATH)
    const other = follow(S1, '/w/b.txt')
    const { source } = await remote.ready(0)
    const otherWatch = await remote.ready(1)
    source.end()
    await expect(a.it.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(b.it.next()).resolves.toEqual({ done: true, value: undefined })
    await feed.settle()
    await otherWatch.source.deliver({ kind: 'change', change: { absolutePath: '/w/b.txt', version: 'v1' } })
    await expect(other.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    const next = follow(S1, PATH)
    await remote.ready(2)
    await expect(next.ready).resolves.toBe(true)
    expect(remote.opened).toHaveLength(3)
  })

  it('ends every follower when its target stream fails', async () => {
    const { remote, feed, follow } = harness()
    const a = follow(S1, PATH)
    const b = follow(S1, PATH)
    const { source } = await remote.ready(0)
    source.fail(new Error('carrier gone for good'))
    await expect(a.it.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(b.it.next()).resolves.toEqual({ done: true, value: undefined })
    await feed.settle()
    expect(source.aborted).toBe(true)
  })
})
