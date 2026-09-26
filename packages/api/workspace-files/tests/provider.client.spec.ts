/** File-provider metadata reads, target subscriptions, failures, and cancellation. */
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceFileStat } from '../src/types.ts'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ChangeFeed } from '../src/client/change-feed.ts'
import { createFileResourceProvider } from '../src/client/provider.ts'
import { FakeRemote } from './fake-remote.client.ts'

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId
const REL_PATH = 'a b.txt'
const HOST_PATH = '/w/a b.txt'
const ADDRESS = sessionFileAddress(S1, REL_PATH)
const ABS_PATH = '/etc/hosts'
const ABS_ADDRESS = sessionFileAddress(S1, ABS_PATH)

const stat = (version: string, bytes: number): WorkspaceFileStat => ({ absolutePath: HOST_PATH, version, bytes })
const notFound = (): RemoteFailure => new RemoteError('workspace-file/not-found', 'no such file', { path: REL_PATH })

function harness() {
  const remote = new FakeRemote()
  remote.autoReady = false
  const changes = new ChangeFeed(remote)
  const provider = createFileResourceProvider(remote, changes)
  const resources: Array<{ controller: AbortController; it: AsyncIterator<RemoteResult<WorkspaceFileStat>> }> = []
  onTestFinished(async () => {
    for (const resource of resources) resource.controller.abort()
    await remote.dispose()
    await Promise.all(resources.map(resource => Promise.resolve(resource.it.return?.())))
    await changes.settle()
    expect(remote.opened.every(watch => watch.source.aborted)).toBe(true)
  })
  const open = (address = ADDRESS) => {
    const controller = new AbortController()
    const it = provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
    const resource = { controller, it }
    resources.push(resource)
    return resource
  }
  return { remote, changes, open }
}

function opened(address = ADDRESS) {
  const bench = harness()
  return { ...bench, ...bench.open(address) }
}

async function live(version = 'v0', bytes = 3) {
  const bench = opened()
  const first = bench.it.next()
  await bench.remote.ready(0)
  const request = await bench.remote.waitForStat(0)
  request.resolve({ ok: true, value: stat(version, bytes) })
  await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: stat(version, bytes) } })
  return bench
}

describe('file provider — the address', () => {
  it.each([
    ['another scope', 'dsh-resource://file/shared/x/w/a.txt'],
    ['no path', 'dsh-resource://file/session/s1'],
    ['an absolute address with no path', 'dsh-resource://file/absolute/'],
    ['another resource type', 'dsh-resource://terminal/session/s1/1'],
    ['the retired file:// grammar', 'file://sessions/s1/w/a.txt'],
    ['a bare file URL', 'file:///w/a.txt'],
    ['another protocol', 'sidebar:guide'],
  ])('yields one unsupported-address failure and ends for %s, touching no Remote', async (_, address) => {
    const { remote, it } = opened(address)
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ ok: false, error: { code: 'workspace-file/unsupported-address', details: { address } } })
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined })
    expect(remote.stats).toEqual([])
    expect(remote.opened).toEqual([])
  })

  it('rejects an absolute address with no Session without touching the Remote', async () => {
    const address = absoluteFileAddress(ABS_PATH)
    const { remote, it } = opened(address)
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ ok: false, error: { code: 'workspace-file/unknown-workspace', details: { address } } })
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined })
    expect(remote.stats).toEqual([])
    expect(remote.opened).toEqual([])
  })

  it('watches and stats the relative input path while matching the Host canonical path', async () => {
    const { remote, it } = opened()
    const first = it.next()
    const watch = await remote.ready(0)
    expect(watch).toMatchObject({ sessionId: S1, path: REL_PATH })
    const initial = await remote.waitForStat(0)
    expect(initial).toMatchObject({ sessionId: S1, path: REL_PATH })
    initial.resolve({ ok: true, value: stat('v0', 3) })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: stat('v0', 3) } })
    const next = it.next()
    await watch.source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const update = await remote.waitForStat(1)
    expect(update).toMatchObject({ sessionId: S1, path: REL_PATH })
    update.resolve({ ok: true, value: stat('v1', 7) })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: stat('v1', 7) } })
  })

  it('watches and stats an absolute path through the Session in its address', async () => {
    const { remote, it } = opened(ABS_ADDRESS)
    const first = it.next()
    const watch = await remote.ready(0)
    expect(watch).toMatchObject({ sessionId: S1, path: ABS_PATH })
    const initial = await remote.waitForStat(0)
    expect(initial).toMatchObject({ sessionId: S1, path: ABS_PATH })
    initial.resolve({ ok: true, value: { absolutePath: ABS_PATH, version: 'v0', bytes: 3 } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: ABS_PATH, version: 'v0', bytes: 3 } } })
    const next = it.next()
    await watch.source.deliver({ kind: 'change', change: { absolutePath: ABS_PATH, version: 'v1' } })
    const update = await remote.waitForStat(1)
    expect(update).toMatchObject({ sessionId: S1, path: ABS_PATH })
    update.resolve({ ok: true, value: { absolutePath: ABS_PATH, version: 'v1', bytes: 8 } })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: ABS_PATH, version: 'v1', bytes: 8 } } })
  })

  it('opens separate streams for the same path in different Sessions', async () => {
    const { remote, open } = harness()
    const one = open(sessionFileAddress(S1, 'a.txt'))
    const first = one.it.next()
    await remote.ready(0)
    const request = await remote.waitForStat(0)
    request.resolve({ ok: true, value: { absolutePath: '/one/a.txt', version: 's1-v0' } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: '/one/a.txt', version: 's1-v0' } } })

    const two = open(sessionFileAddress(S2, 'a.txt'))
    const second = two.it.next()
    await remote.ready(1)
    const other = await remote.waitForStat(1)
    other.resolve({ ok: true, value: { absolutePath: '/two/a.txt', version: 's2-v0' } })
    await expect(second).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: '/two/a.txt', version: 's2-v0' } } })
    expect(remote.opened.map(watch => [watch.sessionId, watch.path])).toEqual([[S1, 'a.txt'], [S2, 'a.txt']])
    expect(remote.stats.map(pending => [pending.sessionId, pending.path])).toEqual([[S1, 'a.txt'], [S2, 'a.txt']])
  })
})

describe('file provider — the opening stat', () => {
  it('stats the decoded relative path after ready and yields its metadata', async () => {
    const { remote, it, controller } = opened()
    const first = it.next()
    await remote.ready(0)
    const request = await remote.waitForStat(0)
    expect(remote.stats).toHaveLength(1)
    expect(remote.calls).toEqual(['changes', 'accept', 'stat'])
    expect(request).toMatchObject({ sessionId: S1, path: REL_PATH, signal: controller.signal })
    request.resolve({ ok: true, value: stat('v0', 3) })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: stat('v0', 3) } })
  })

  it('does not stat or emit metadata when a ready observer cancels before the provider resumes', async () => {
    const { remote, changes, it, controller } = opened()
    const observer = changes.follow(S1, REL_PATH, controller.signal)
    // Register this readiness reaction before the provider awaits the shared acknowledgement.
    const cancelled = observer.ready.then((acknowledged) => {
      if (acknowledged) controller.abort()
      return acknowledged
    })
    const first = it.next()
    const { source } = await remote.ready(0)
    await expect(cancelled).resolves.toBe(true)
    await expect(first).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.calls).toEqual(['changes', 'accept'])
    expect(remote.stats).toEqual([])
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
    expect(source.aborted).toBe(true)
  })

  it('omits bytes when the backend reports none', async () => {
    const { remote, it } = opened()
    const first = it.next()
    await remote.ready(0)
    const request = await remote.waitForStat(0)
    request.resolve({ ok: true, value: { absolutePath: HOST_PATH, version: 'v0' } })
    await expect(first).resolves.toStrictEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v0' } } })
  })

  it('yields an initial Host failure and recovers when the watched target changes', async () => {
    const { remote, it } = opened()
    const first = it.next()
    const { source } = await remote.ready(0)
    const initial = await remote.waitForStat(0)
    const error = notFound()
    initial.resolve({ ok: false, error })
    await expect(first).resolves.toEqual({ done: false, value: { ok: false, error } })
    const pending = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const retry = await remote.waitForStat(1)
    retry.resolve({ ok: true, value: stat('v1', 5) })
    await expect(pending).resolves.toEqual({ done: false, value: { ok: true, value: stat('v1', 5) } })
    expect(remote.stats).toHaveLength(2)
  })

  it('does not re-stat or emit another absence after an initial failure', async () => {
    const { remote, it, changes } = opened()
    const first = it.next()
    const { source } = await remote.ready(0)
    const request = await remote.waitForStat(0)
    const error = notFound()
    request.resolve({ ok: false, error })
    await expect(first).resolves.toEqual({ done: false, value: { ok: false, error } })
    const pending = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    source.end()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.stats).toHaveLength(1)
  })

  it('ends without a frame when aborted during the stat', async () => {
    const { remote, it, controller } = opened()
    const first = it.next()
    await remote.ready(0)
    const request = await remote.waitForStat(0)
    controller.abort()
    request.resolve({ ok: false, error: new RemoteError('gateway/internal', 'aborted', {}) })
    await expect(first).resolves.toEqual({ done: true, value: undefined })
  })

  it('opens separate streams for different files and waits for each target acknowledgement', async () => {
    const { remote, open } = harness()
    const a = open(sessionFileAddress(S1, 'a.txt'))
    const b = open(sessionFileAddress(S1, 'b.txt'))
    const first = a.it.next()
    const second = b.it.next()
    const watch = await remote.ready(0)
    expect(watch.path).toBe('a.txt')
    const request = await remote.waitForStat(0)
    expect(remote.stats).toHaveLength(1)
    expect(request.path).toBe('a.txt')
    request.resolve({ ok: true, value: { absolutePath: '/w/a.txt', version: 'a0' } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: '/w/a.txt', version: 'a0' } } })
    const otherWatch = await remote.ready(1)
    expect(otherWatch.path).toBe('b.txt')
    const otherRequest = await remote.waitForStat(1)
    otherRequest.resolve({ ok: true, value: { absolutePath: '/w/b.txt', version: 'b0' } })
    await expect(second).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: '/w/b.txt', version: 'b0' } } })
    expect(remote.opened).toHaveLength(2)
    expect(remote.stats).toHaveLength(2)
  })

  it('shares one target stream across consumers while keeping their stats and cancellation independent', async () => {
    const { remote, changes, open } = harness()
    const a = open()
    const b = open()
    const first = a.it.next()
    const second = b.it.next()
    const { source } = await remote.ready(0)
    const requests = await Promise.all([remote.waitForStat(0), remote.waitForStat(1)])
    for (const request of requests) {
      expect(request).toMatchObject({ sessionId: S1, path: REL_PATH })
      request.resolve({ ok: true, value: stat('v0', 3) })
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: false, value: { ok: true, value: stat('v0', 3) } },
      { done: false, value: { ok: true, value: stat('v0', 3) } },
    ])
    expect(remote.opened).toHaveLength(1)
    a.controller.abort()
    await expect(a.it.next()).resolves.toEqual({ done: true, value: undefined })
    expect(source.aborted).toBe(false)
    const next = b.it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const update = await remote.waitForStat(2)
    expect(update.signal).toBe(b.controller.signal)
    update.resolve({ ok: true, value: stat('v1', 9) })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: stat('v1', 9) } })
    b.controller.abort()
    await expect(b.it.next()).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })
})

describe('file provider — Host writes', () => {
  it.each([
    ['changed byte count', stat('v1', 17)],
    ['a newer version than the notification', stat('v2', 9)],
    ['an omitted byte count', { absolutePath: HOST_PATH, version: 'v1' }],
  ])('re-reads complete metadata after a write with %s', async (_, metadata) => {
    const { remote, it, controller } = await live()
    const next = it.next()
    await remote.opened[0]!.source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const request = await remote.waitForStat(1)
    expect(request).toMatchObject({ sessionId: S1, path: REL_PATH, signal: controller.signal })
    request.resolve({ ok: true, value: metadata })
    await expect(next).resolves.toStrictEqual({ done: false, value: { ok: true, value: metadata } })
    expect(remote.stats).toHaveLength(2)
  })

  it('ignores a held version and still reads a later different version', async () => {
    const { remote, it } = await live('v0')
    const source = remote.opened[0]!.source
    const pending = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v0' } })
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const request = await remote.waitForStat(1)
    request.resolve({ ok: true, value: stat('v1', 5) })
    await expect(pending).resolves.toEqual({ done: false, value: { ok: true, value: stat('v1', 5) } })
    expect(remote.stats).toHaveLength(2)
  })

  it('does not read or emit metadata for a duplicate version before the stream ends', async () => {
    const { remote, it, changes } = await live('v0')
    const source = remote.opened[0]!.source
    const pending = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v0' } })
    source.end()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.stats).toHaveLength(1)
  })

  it('does not lose a write delivered while the opening stat is unresolved', async () => {
    const { remote, it } = opened()
    const first = it.next()
    const { source } = await remote.ready(0)
    const initial = await remote.waitForStat(0)
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    initial.resolve({ ok: true, value: stat('v0', 3) })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: stat('v0', 3) } })
    const next = it.next()
    const update = await remote.waitForStat(1)
    update.resolve({ ok: true, value: stat('v1', 11) })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: stat('v1', 11) } })
    expect(remote.stats).toHaveLength(2)
  })

  it('queues a further change while metadata refresh is unresolved', async () => {
    const { remote, it } = await live()
    const source = remote.opened[0]!.source
    const first = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const initial = await remote.waitForStat(1)
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v2' } })
    initial.resolve({ ok: true, value: stat('v1', 5) })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: stat('v1', 5) } })
    const next = it.next()
    const update = await remote.waitForStat(2)
    update.resolve({ ok: true, value: stat('v2', 12) })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: stat('v2', 12) } })
    expect(remote.stats).toHaveLength(3)
  })

  it('yields a metadata failure and retries even when the next notice repeats the last successful version', async () => {
    const { remote, it } = await live()
    const source = remote.opened[0]!.source
    const next = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    const update = await remote.waitForStat(1)
    const error = new RemoteError('gateway/internal', 'metadata unavailable', {})
    update.resolve({ ok: false, error })
    await expect(next).resolves.toEqual({ done: false, value: { ok: false, error } })
    const recovered = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v0' } })
    const retry = await remote.waitForStat(2)
    retry.resolve({ ok: true, value: stat('v2', 8) })
    await expect(recovered).resolves.toEqual({ done: false, value: { ok: true, value: stat('v2', 8) } })
  })
})

describe('file provider — a reported disappearance', () => {
  it('ends quietly when aborted during the stat', async () => {
    const { remote, it, controller, changes } = await live()
    const next = it.next()
    await remote.opened[0]!.source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    const request = await remote.waitForStat(1)
    controller.abort()
    request.resolve({ ok: true, value: stat('late', 9) })
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })

  it('stats again and yields fresh metadata when the file is still there', async () => {
    const { remote, it } = await live('v0', 3)
    const next = it.next()
    await remote.opened[0]!.source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    const request = await remote.waitForStat(1)
    expect(remote.stats).toHaveLength(2)
    request.resolve({ ok: true, value: stat('v2', 9) })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: stat('v2', 9) } })
  })

  it('yields not-found and keeps following so a later write can bring the file back', async () => {
    const { remote, it } = await live('v0', 3)
    const source = remote.opened[0]!.source
    const next = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    const request = await remote.waitForStat(1)
    const error = notFound()
    request.resolve({ ok: false, error })
    await expect(next).resolves.toEqual({ done: false, value: { ok: false, error } })
    const back = it.next()
    await source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v3' } })
    const retry = await remote.waitForStat(2)
    retry.resolve({ ok: true, value: stat('v3', 8) })
    await expect(back).resolves.toEqual({ done: false, value: { ok: true, value: stat('v3', 8) } })
  })
})

describe('file provider — the end', () => {
  it('does not start another stat for a change queued before cancellation', async () => {
    const { remote, it, controller, changes } = await live()
    await remote.opened[0]!.source.deliver({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    controller.abort()
    await changes.settle()
    const next = it.next()
    await expect(Promise.race([next, remote.waitForStat(1)])).resolves.toEqual({ done: true, value: undefined })
    expect(remote.stats).toHaveLength(1)
  })

  it('ends a pending pull when its signal aborts and releases the target stream', async () => {
    const { remote, it, controller, changes } = await live()
    const next = it.next()
    controller.abort()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })

  it('ends when the Host closes the target stream', async () => {
    const { remote, it, changes } = await live()
    remote.opened[0]!.source.end()
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })
})
