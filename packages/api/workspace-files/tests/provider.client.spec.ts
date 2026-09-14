/**
 * The `file` provider's frame stream: how the two address scopes resolve to a
 * Host call and a change-feed key, the opening stat, the write version that
 * carries no content, the disappearance that stats again, failures
 * as frames, and the life bounded by the signal.
 */
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceFileStat } from '../src/types.ts'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ChangeFeed } from '../src/client/change-feed.ts'
import { createFileResourceProvider } from '../src/client/provider.ts'
import { FakeRemote, settle } from './fake-remote.client.ts'

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId
/** The relative path the address carries, and the absolute path the Host's frames spell for it under S1's root. */
const REL_PATH = 'a b.txt'
const HOST_PATH = '/w/a b.txt'
const ADDRESS = sessionFileAddress(S1, REL_PATH)
/** A file outside every workspace root, addressed absolutely. */
const ABS_PATH = '/etc/hosts'
const ABS_ADDRESS = sessionFileAddress(S1, ABS_PATH)

const stat = (version: string, bytes: number): WorkspaceFileStat => ({ absolutePath: HOST_PATH, version, bytes })
const notFound = (): RemoteFailure => new RemoteError('workspace-file/not-found', 'no such file', { path: REL_PATH })

function opened(address = ADDRESS) {
  const remote = new FakeRemote()
  const changes = new ChangeFeed(remote)
  const provider = createFileResourceProvider(remote, changes)
  const controller = new AbortController()
  const it = provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
  onTestFinished(async () => {
    controller.abort()
    for (const request of remote.stats) {
      request.resolve({ ok: false, error: new RemoteError('gateway/internal', 'test ended', {}) })
    }
    await it.return?.()
    await changes.settle()
  })
  return { remote, provider, changes, controller, it }
}

/** Open, answer the opening stat, and hand back the bench once the first frame is out. */
async function live(version = 'v0', bytes = 3) {
  const bench = opened()
  const first = bench.it.next()
  await settle()
  bench.remote.stats[0]!.resolve({ ok: true, value: stat(version, bytes) })
  await first
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

  it('hands the Host a session address\'s relative path and follows the stat absolute path', async () => {
    const { remote, it } = opened()
    const first = it.next()
    await settle()
    expect(remote.stats[0]).toMatchObject({ sessionId: S1, path: REL_PATH })
    remote.stats[0]!.resolve({ ok: true, value: stat('v0', 3) })
    await first
    // The Host's frame names the file absolutely; the follower keyed by the resolved path receives it.
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    await expect(it.next()).resolves.toMatchObject({ value: { ok: true, value: { version: 'v1' } } })
  })

  it('reads an absolute path through the Session in its address, with the absolute path as both Host path and follow key', async () => {
    const { remote, it } = opened(ABS_ADDRESS)
    const first = it.next()
    await settle()
    expect(remote.opened.map(o => o.sessionId)).toEqual([S1])
    expect(remote.stats[0]).toMatchObject({ sessionId: S1, path: ABS_PATH })
    remote.stats[0]!.resolve({ ok: true, value: { absolutePath: ABS_PATH, version: 'v0', bytes: 3 } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: ABS_PATH, version: 'v0', bytes: 3 } } })
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: ABS_PATH, version: 'v1' } })
    await expect(it.next()).resolves.toMatchObject({ value: { ok: true, value: { version: 'v1' } } })
  })

  it('opens one change stream per session named by the addresses', async () => {
    const remote = new FakeRemote()
    const provider = createFileResourceProvider(remote, new ChangeFeed(remote))
    const signal = new AbortController().signal
    void provider.open(sessionFileAddress(S1, 'a.txt'), { signal })[Symbol.asyncIterator]().next()
    void provider.open(sessionFileAddress(S2, 'a.txt'), { signal })[Symbol.asyncIterator]().next()
    await settle()
    expect(remote.opened.map(o => o.sessionId)).toEqual([S1, S2])
    expect(remote.stats.map(pending => pending.sessionId)).toEqual([S1, S2])
  })
})

describe('file provider — the opening stat', () => {
  it('stats the decoded relative path in the session the address names and yields its metadata', async () => {
    const { remote, it, controller } = opened()
    const first = it.next()
    await settle()
    expect(remote.stats).toHaveLength(1)
    expect(remote.stats[0]).toMatchObject({ sessionId: S1, path: REL_PATH, signal: controller.signal })
    remote.stats[0]!.resolve({ ok: true, value: stat('v0', 3) })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v0', bytes: 3 } } })
  })

  it('omits bytes when the backend reports none', async () => {
    const { remote, it } = opened()
    const first = it.next()
    await settle()
    remote.stats[0]!.resolve({ ok: true, value: { absolutePath: HOST_PATH, version: 'v0' } })
    await expect(first).resolves.toStrictEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v0' } } })
  })

  it('yields the Host failure as a frame and keeps following the address', async () => {
    const { remote, it } = opened()
    const first = it.next()
    await settle()
    const error = notFound()
    remote.stats[0]!.resolve({ ok: false, error })
    await expect(first).resolves.toEqual({ done: false, value: { ok: false, error } })
    const source = remote.opened[0]!.source
    // Still gone: no stat, no frame; the pull stays open for what comes next.
    source.push({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    const pending = it.next()
    await expect(Promise.race([pending, settle().then(() => 'silent' as const)])).resolves.toBe('silent')
    expect(remote.stats).toHaveLength(1)
    // The agent creates the file: the write stats again and the value goes live.
    source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    await settle()
    remote.stats[1]!.resolve({ ok: true, value: stat('v1', 5) })
    await expect(pending).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v1', bytes: 5 } } })
  })

  it('ends without a frame when aborted during the stat', async () => {
    const { remote, it, controller } = opened()
    const first = it.next()
    await settle()
    controller.abort()
    remote.stats[0]!.resolve({ ok: false, error: new RemoteError('gateway/internal', 'aborted', {}) })
    await expect(first).resolves.toEqual({ done: true, value: undefined })
  })

  it('shares one change stream between two files of a session', async () => {
    const remote = new FakeRemote()
    const provider = createFileResourceProvider(remote, new ChangeFeed(remote))
    const signal = new AbortController().signal
    void provider.open(sessionFileAddress(S1, 'a.txt'), { signal })[Symbol.asyncIterator]().next()
    void provider.open(sessionFileAddress(S1, 'b.txt'), { signal })[Symbol.asyncIterator]().next()
    await settle()
    expect(remote.opened).toHaveLength(1)
    expect(remote.stats).toHaveLength(2)
  })
})

describe('file provider — Host writes', () => {
  it('reports a write with its version and keeps the byte count', async () => {
    const { remote, it } = await live()
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    await expect(it.next()).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v1', bytes: 3 } } })
    expect(remote.stats).toHaveLength(1)
  })

  it('ignores a frame carrying the version it already holds', async () => {
    const { remote, it } = await live('v0')
    const source = remote.opened[0]!.source
    source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v0' } })
    // The pull outlives the silent tick: the frame that finally answers it is v1.
    const pending = it.next()
    await expect(Promise.race([pending, settle().then(() => 'silent' as const)])).resolves.toBe('silent')
    source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    await expect(pending).resolves.toMatchObject({ value: { ok: true, value: { version: 'v1' } } })
  })

  it('does not lose a write reported during the opening stat', async () => {
    const { remote, it } = opened()
    const first = it.next()
    await settle()
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v1' } })
    await settle()
    remote.stats[0]!.resolve({ ok: true, value: stat('v0', 3) })
    await expect(first).resolves.toMatchObject({ value: { ok: true, value: { version: 'v0' } } })
    await expect(it.next()).resolves.toMatchObject({ value: { ok: true, value: { version: 'v1' } } })
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

  it('stats again and, when the file is still there, yields its fresh metadata', async () => {
    const { remote, it } = await live('v0', 3)
    remote.opened[0]!.source.push({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    const next = it.next()
    await settle()
    expect(remote.stats).toHaveLength(2)
    remote.stats[1]!.resolve({ ok: true, value: stat('v2', 9) })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v2', bytes: 9 } } })
  })

  it('yields the not-found frame and keeps following, so a later write stats again and brings the file back', async () => {
    const { remote, it } = await live('v0', 3)
    const source = remote.opened[0]!.source
    source.push({ kind: 'change', change: { absolutePath: HOST_PATH, absent: true } })
    const next = it.next()
    await settle()
    const error = notFound()
    remote.stats[1]!.resolve({ ok: false, error })
    await expect(next).resolves.toEqual({ done: false, value: { ok: false, error } })
    source.push({ kind: 'change', change: { absolutePath: HOST_PATH, version: 'v3' } })
    const back = it.next()
    await settle()
    remote.stats[2]!.resolve({ ok: true, value: stat('v3', 8) })
    await expect(back).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: HOST_PATH, version: 'v3', bytes: 8 } } })
  })
})

describe('file provider — the end', () => {
  it('ends when its signal aborts and releases the session stream', async () => {
    const { remote, it, controller } = await live()
    controller.abort()
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined })
    await settle()
    expect(remote.disposed).toEqual(['workspace file changes of s1'])
  })

  it('ends when the Host closes the session stream', async () => {
    const { remote, it } = await live()
    remote.opened[0]!.source.end()
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined })
  })
})
