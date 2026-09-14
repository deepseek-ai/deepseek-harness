/**
 * The change feed's promises: one Host stream per session, delivery by absolute
 * path, and a follower's life bounded by its signal or by
 * the stream's end.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { ChangeFeed } from '../src/client/change-feed.ts'
import type { WorkspaceFileWatchFrame } from '../src/types.ts'
import { FakeRemote, peek, settle } from './fake-remote.client.ts'

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId

function harness() {
  const remote = new FakeRemote()
  const feed = new ChangeFeed(remote)
  const follow = (sessionId: SessionId, path: string, controller = new AbortController()) => {
    const follower = feed.follow(sessionId, controller.signal)
    follower.bind(path)
    return { it: follower[Symbol.asyncIterator](), controller }
  }
  return { remote, feed, follow }
}

describe('ChangeFeed — one Host stream per session', () => {
  it('starts a later follower from the existing session acknowledgement without opening another stream', async () => {
    const { remote, feed } = harness()
    const controller = new AbortController()
    const first = feed.follow(S1, controller.signal)
    try {
      await expect(first.ready).resolves.toBe(true)
      const second = feed.follow(S1, controller.signal)
      await expect(second.ready).resolves.toBe(true)
      expect(remote.calls).toEqual(['changes', 'accept'])
      expect(remote.opened).toHaveLength(1)

      second.bind('/w/second.txt')
      const iterator = second[Symbol.asyncIterator]()
      await remote.opened[0]!.source.deliver({
        kind: 'change', change: { absolutePath: '/w/second.txt', version: 'v1' },
      })
      await expect(iterator.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
      controller.abort()
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
      await feed.settle()
      expect(remote.disposed).toEqual(['workspace file changes of s1'])
    } finally {
      controller.abort()
      await feed.settle()
    }
  })

  it('shares one stream among the followers of a session and opens another per session', async () => {
    const { remote, follow } = harness()
    follow(S1, '/w/a.txt')
    follow(S1, '/w/b.txt')
    await settle()
    expect(remote.opened.map(o => o.sessionId)).toEqual([S1])
    follow(S2, '/w/a.txt')
    await settle()
    expect(remote.opened.map(o => o.sessionId)).toEqual([S1, S2])
  })

  it('disposes the session stream when its last follower leaves and reopens for the next', async () => {
    const { remote, follow } = harness()
    const a = follow(S1, '/w/a.txt')
    const b = follow(S1, '/w/b.txt')
    await settle()
    a.controller.abort()
    await settle()
    expect(remote.disposed).toEqual([])
    b.controller.abort()
    await settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
    expect(remote.opened[0]!.source.aborted).toBe(true)
    follow(S1, '/w/c.txt')
    await settle()
    expect(remote.opened).toHaveLength(2)
  })

  it('opens the next stream of a session only after the previous dispose settled, and settle() waits for it', async () => {
    const { remote, feed, follow } = harness()
    let release!: () => void
    remote.disposeGate = new Promise<void>((resolve) => { release = resolve })
    const a = follow(S1, '/w/a.txt')
    await settle()
    a.controller.abort()
    await settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
    // The next follower registers at once, but its Host stream waits for the close.
    follow(S1, '/w/b.txt')
    await settle()
    expect(remote.opened).toHaveLength(1)
    let settled = false
    void feed.settle().then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)
    release()
    await settle()
    expect(remote.opened).toHaveLength(2)
    expect(settled).toBe(true)
    // Nothing left closing: settle() resolves at once.
    await feed.settle()
  })

  it('keeps waiting for the newest close when two closes of one session overlap', async () => {
    const { remote, feed, follow } = harness()
    let release!: () => void
    remote.disposeGate = new Promise<void>((resolve) => { release = resolve })
    const a = follow(S1, '/w/a.txt')
    await settle()
    a.controller.abort()
    await settle()
    // The second feed waits for the first close, then its only follower leaves too.
    const b = follow(S1, '/w/b.txt')
    await settle()
    b.controller.abort()
    await settle()
    let settled = false
    void feed.settle().then(() => { settled = true })
    release()
    await settle()
    await settle()
    expect(settled).toBe(true)
    expect(remote.disposed).toHaveLength(2)
    follow(S1, '/w/c.txt')
    await settle()
    expect(remote.opened).toHaveLength(3)
  })

  it('treats a dispose that rejects as settled, so the next stream still opens', async () => {
    const { remote, feed, follow } = harness()
    // Rejected only once dispose() has taken the gate, so the rejection always has a handler.
    let fail!: (error: Error) => void
    remote.disposeGate = new Promise<void>((_resolve, reject) => { fail = reject })
    const a = follow(S1, '/w/a.txt')
    await settle()
    a.controller.abort()
    await settle()
    follow(S1, '/w/b.txt')
    await settle()
    expect(remote.opened).toHaveLength(1)
    fail(new Error('carrier gone'))
    await settle()
    expect(remote.opened).toHaveLength(2)
    await feed.settle()
  })
})

describe('ChangeFeed — delivery', () => {
  it('routes a frame to the followers of its path, whichever separator the Host spells', async () => {
    const { remote, follow } = harness()
    // A stat and a change frame may spell the same Host path with different separators.
    const mine = follow(S1, 'C:/w/a b.txt')
    const twin = follow(S1, 'C:/w/a b.txt')
    const other = follow(S1, 'C:/w/other.txt')
    await settle()
    const source = remote.opened[0]!.source
    source.push({ kind: 'change', change: { absolutePath: 'C:/w/a b.txt', version: 'v1' } })
    source.push({ kind: 'change', change: { absolutePath: 'C:\\w\\a b.txt', absent: true } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'absent' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await expect(peek(other.it)).resolves.toBe('silent')
    // One follower of a path leaving does not silence the other.
    mine.controller.abort()
    await settle()
    source.push({ kind: 'change', change: { absolutePath: 'C:/w/a b.txt', version: 'v2' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'absent' } })
    await expect(twin.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v2' } })
  })

  it('queues frames reported before the consumer starts pulling', async () => {
    const { remote, follow } = harness()
    const mine = follow(S1, '/w/a.txt')
    await settle()
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: '/w/a.txt', version: 'v1' } })
    await settle()
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
  })

  it('keeps sessions apart', async () => {
    const { remote, follow } = harness()
    const one = follow(S1, '/w/a.txt')
    const two = follow(S2, '/w/a.txt')
    await settle()
    remote.opened[1]!.source.push({ kind: 'change', change: { absolutePath: '/w/a.txt', version: 'v2' } })
    await expect(two.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v2' } })
    await expect(peek(one.it)).resolves.toBe('silent')
  })
})

describe('ChangeFeed — a follower ends', () => {
  it('ends every follower and disposes the session stream for an unknown wire frame kind', async () => {
    const { remote, feed } = harness()
    const controller = new AbortController()
    const first = feed.follow(S1, controller.signal)
    const second = feed.follow(S1, controller.signal)
    const firstIterator = first[Symbol.asyncIterator]()
    const secondIterator = second[Symbol.asyncIterator]()
    try {
      await expect(Promise.all([first.ready, second.ready])).resolves.toEqual([true, true])
      const endings = Promise.all([firstIterator.next(), secondIterator.next()])
      const source = remote.opened[0]!.source
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
    } finally {
      controller.abort()
      await Promise.all([firstIterator.return?.(), secondIterator.return?.()])
      await feed.settle()
    }
  })

  it('ends on its signal and drops nothing queued before it', async () => {
    const { remote, follow } = harness()
    const mine = follow(S1, '/w/a.txt')
    await settle()
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: '/w/a.txt', version: 'v1' } })
    await settle()
    mine.controller.abort()
    await expect(mine.it.next()).resolves.toEqual({ done: false, value: { kind: 'changed', version: 'v1' } })
    await expect(mine.it.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('is empty when the signal is already aborted, without opening a stream', async () => {
    const { remote, feed } = harness()
    const controller = new AbortController()
    controller.abort()
    const it = feed.follow(S1, controller.signal)[Symbol.asyncIterator]()
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined })
    await settle()
    expect(remote.opened).toEqual([])
  })

  it('unregisters when the consumer breaks out after a notice', async () => {
    const { remote, follow } = harness()
    const mine = follow(S1, '/w/a.txt')
    await settle()
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: '/w/a.txt', version: 'v1' } })
    await mine.it.next()
    await mine.it.return?.()
    await settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })

  it('ends every follower when the Host closes the session stream', async () => {
    const { remote, follow } = harness()
    const a = follow(S1, '/w/a.txt')
    const b = follow(S1, '/w/b.txt')
    await settle()
    remote.opened[0]!.source.end()
    await expect(a.it.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(b.it.next()).resolves.toEqual({ done: true, value: undefined })
    // The next follower starts a fresh stream rather than joining the dead one.
    follow(S1, '/w/c.txt')
    await settle()
    expect(remote.opened).toHaveLength(2)
  })

  it('ends every follower when the session stream fails', async () => {
    const { remote, follow } = harness()
    const a = follow(S1, '/w/a.txt')
    await settle()
    remote.opened[0]!.source.fail(new Error('carrier gone for good'))
    await expect(a.it.next()).resolves.toEqual({ done: true, value: undefined })
  })
})
