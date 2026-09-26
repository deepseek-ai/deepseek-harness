/** Host-resolved file identities across pending stats, reconnects, and disposal. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ChangeFeed } from '../src/client/change-feed.ts'
import { createFileResourceProvider } from '../src/client/provider.ts'
import type { WorkspaceFileStat } from '../src/types.ts'
import { FakeRemote } from './fake-remote.client.ts'

const SESSION = 'host-only' as SessionId
const RELATIVE = 'linked/a b.txt'
const ADDRESS = sessionFileAddress(SESSION, RELATIVE)
const CANONICAL = '/host/canonical/a b.txt'

function harness() {
  const remote = new FakeRemote()
  remote.autoReady = false
  const changes = new ChangeFeed(remote)
  const provider = createFileResourceProvider(remote, changes)
  const resources: Array<{ controller: AbortController; iterator: AsyncIterator<RemoteResult<WorkspaceFileStat>> }> = []
  onTestFinished(async () => {
    for (const resource of resources) resource.controller.abort()
    await remote.dispose()
    await Promise.all(resources.map(resource => Promise.resolve(resource.iterator.return?.())))
    await changes.settle()
    expect(remote.opened.every(watch => watch.source.aborted)).toBe(true)
  })
  const open = (address = ADDRESS) => {
    const controller = new AbortController()
    const iterator = provider.open(address, { signal: controller.signal })[Symbol.asyncIterator]()
    const resource = { iterator, controller }
    resources.push(resource)
    return resource
  }
  return { remote, changes, open }
}

describe('Host-resolved file paths', () => {
  it('accepts Host ready before submitting the unmodified relative path without a Client Session summary', async () => {
    const { remote, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const watch = await remote.ready(0)
    expect(watch).toMatchObject({ sessionId: SESSION, path: RELATIVE })
    const request = await remote.waitForStat(0)
    expect(remote.calls).toEqual(['changes', 'accept', 'stat'])
    expect(request).toMatchObject({ sessionId: SESSION, path: RELATIVE })
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } } })
  })

  it('does not stat an opened changes stream until the Host acknowledges its subscription', async () => {
    const { remote, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const { source } = await remote.waitForChanges(0)
    expect(remote.calls).toEqual(['changes'])
    expect(remote.stats).toEqual([])

    await source.deliver({ kind: 'ready' })
    const request = await remote.waitForStat(0)
    expect(remote.calls).toEqual(['changes', 'accept', 'stat'])
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v0' } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'v0' } } })
  })

  it.each(['abort', 'end', 'failure', 'watch-unsupported'] as const)('settles %s before Host ready with one fallback stat unless aborted', async (ending) => {
    const { remote, changes, open } = harness()
    const { iterator, controller } = open()
    const first = iterator.next()
    const { source } = await remote.waitForChanges(0)
    switch (ending) {
      case 'abort': controller.abort(); break
      case 'end': source.end(); break
      case 'failure': source.fail(new Error('workspace root unavailable')); break
      case 'watch-unsupported':
        source.fail(new RemoteError('workspace-file/watch-unsupported', 'watch unavailable', { path: RELATIVE }))
        break
      default: throw new Error(`Unexpected stream ending: ${ending satisfies never}`)
    }
    await remote.waitForDispose(0)
    await changes.settle()
    if (ending === 'abort') {
      expect(remote.calls).toEqual(['changes'])
      expect(remote.stats).toEqual([])
      await expect(first).resolves.toEqual({ done: true, value: undefined })
    } else {
      const request = await remote.waitForStat(0)
      expect(request).toMatchObject({ sessionId: SESSION, path: RELATIVE, signal: controller.signal })
      const result: RemoteResult<WorkspaceFileStat> = ending === 'failure'
        ? { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path: RELATIVE }) }
        : { ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } }
      request.resolve(result)
      await expect(first).resolves.toEqual({ done: false, value: result })
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
      expect(remote.calls).toEqual(['changes', 'stat'])
      expect(remote.stats).toHaveLength(1)
    }
    expect(remote.disposed).toEqual(['workspace file changes of ' + SESSION])
    expect(source.aborted).toBe(true)
  })

  it('ends without a frame when aborted during the fallback stat', async () => {
    const { remote, changes, open } = harness()
    const { iterator, controller } = open()
    const first = iterator.next()
    const { source } = await remote.waitForChanges(0)
    source.fail(new RemoteError('workspace-file/watch-unsupported', 'watch unavailable', { path: RELATIVE }))
    const request = await remote.waitForStat(0)
    expect(request).toMatchObject({ sessionId: SESSION, path: RELATIVE, signal: controller.signal })
    controller.abort()
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'late', bytes: 9 } })
    await expect(first).resolves.toEqual({ done: true, value: undefined })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.calls).toEqual(['changes', 'stat'])
    expect(remote.stats).toHaveLength(1)
    expect(remote.disposed).toEqual(['workspace file changes of ' + SESSION])
    expect(source.aborted).toBe(true)
  })

  it.each(['v0', 'v1'])('re-stats complete metadata on a later ready even when the stat version is %s', async (version) => {
    const { remote, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const { source } = await remote.ready(0)
    const request = await remote.waitForStat(0)
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } } })
    const next = iterator.next()
    await source.deliver({ kind: 'ready' })
    const refresh = await remote.waitForStat(1)
    expect(refresh).toMatchObject({ sessionId: SESSION, path: RELATIVE })
    expect(remote.calls).toEqual(['changes', 'accept', 'stat', 'accept', 'stat'])
    refresh.resolve({ ok: true, value: { absolutePath: CANONICAL, version, bytes: 12 } })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version, bytes: 12 } } })
    expect(remote.opened).toHaveLength(1)
    expect(remote.stats).toHaveLength(2)
  })

  it('retries a failed opening stat after reconnect ready without requiring a change frame', async () => {
    const { remote, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const { source } = await remote.ready(0)
    const request = await remote.waitForStat(0)
    const error = new RemoteError('workspace-file/not-found', 'missing', { path: RELATIVE })
    request.resolve({ ok: false, error })
    await expect(first).resolves.toEqual({ done: false, value: { ok: false, error } })
    const next = iterator.next()
    await source.deliver({ kind: 'ready' })
    const retry = await remote.waitForStat(1)
    expect(retry).toMatchObject({ sessionId: SESSION, path: RELATIVE })
    retry.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v1', bytes: 5 } })
    await expect(next).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'v1', bytes: 5 } } })
    expect(remote.stats).toHaveLength(2)
  })

  it.each([
    ['relative', ADDRESS, RELATIVE],
    ['absolute', sessionFileAddress(SESSION, '/shortcut/a.txt'), '/shortcut/a.txt'],
  ])('filters queued and live %s changes using the Host canonical path and re-stats the input path', async (_, address, path) => {
    const { remote, changes, open } = harness()
    const { iterator } = open(address)
    const first = iterator.next()
    const watch = await remote.ready(0)
    expect(watch).toMatchObject({ sessionId: SESSION, path })
    const request = await remote.waitForStat(0)
    expect(request).toMatchObject({ sessionId: SESSION, path })
    const source = watch.source
    await source.deliver({ kind: 'change', change: { absolutePath: '/other/file.txt', version: 'other-before-stat' } })
    await source.deliver({ kind: 'change', change: { absolutePath: CANONICAL, version: 'write-v1' } })
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'v0', bytes: 3 } } })
    const queued = iterator.next()
    const queuedStat = await remote.waitForStat(1)
    expect(queuedStat).toMatchObject({ sessionId: SESSION, path })
    // Different stat and notice versions prevent duplicate suppression from hiding a misrouted frame.
    queuedStat.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'read-v1', bytes: 6 } })
    await expect(queued).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'read-v1', bytes: 6 } } })

    const live = iterator.next()
    await source.deliver({ kind: 'change', change: { absolutePath: '/other/file.txt', version: 'other-after-stat' } })
    await source.deliver({ kind: 'change', change: { absolutePath: CANONICAL, version: 'write-v2' } })
    const liveStat = await remote.waitForStat(2)
    expect(liveStat).toMatchObject({ sessionId: SESSION, path })
    liveStat.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'read-v2', bytes: 9 } })
    await expect(live).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'read-v2', bytes: 9 } } })
    source.end()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.stats).toHaveLength(3)
    expect(remote.opened).toHaveLength(1)
  })

  it('recovers an initial failed stat through a target write and filters the retry backlog after binding', async () => {
    const { remote, changes, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const watch = await remote.ready(0)
    expect(watch.path).toBe(RELATIVE)
    const request = await remote.waitForStat(0)
    const error = new RemoteError('workspace-file/not-found', 'missing', { path: RELATIVE })
    request.resolve({ ok: false, error })
    await expect(first).resolves.toEqual({ done: false, value: { ok: false, error } })
    const source = watch.source
    const retried = iterator.next()
    await source.deliver({ kind: 'change', change: { absolutePath: CANONICAL, version: 'trigger' } })
    const retry = await remote.waitForStat(1)
    expect(retry).toMatchObject({ sessionId: SESSION, path: RELATIVE })
    await source.deliver({ kind: 'change', change: { absolutePath: '/other/file.txt', version: 'other' } })
    await source.deliver({ kind: 'change', change: { absolutePath: CANONICAL, version: 'write-v3' } })
    retry.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'read-v2', bytes: 5 } })
    await expect(retried).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'read-v2', bytes: 5 } } })
    const queued = iterator.next()
    const update = await remote.waitForStat(2)
    update.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'read-v3', bytes: 8 } })
    await expect(queued).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'read-v3', bytes: 8 } } })
    source.end()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.stats).toHaveLength(3)
  })

  it('binds a changed canonical path after disappearance before filtering writes received during that stat', async () => {
    const { remote, changes, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const { source } = await remote.ready(0)
    const request = await remote.waitForStat(0)
    request.resolve({ ok: true, value: { absolutePath: '/host/old-target.txt', version: 'v0' } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: '/host/old-target.txt', version: 'v0' } } })
    const reloaded = iterator.next()
    await source.deliver({ kind: 'change', change: { absolutePath: '/host/old-target.txt', absent: true } })
    const retry = await remote.waitForStat(1)
    await source.deliver({ kind: 'change', change: { absolutePath: '/host/old-target.txt', version: 'old-target-write' } })
    await source.deliver({ kind: 'change', change: { absolutePath: CANONICAL, version: 'write-v2' } })
    retry.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'read-v1', bytes: 7 } })
    await expect(reloaded).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'read-v1', bytes: 7 } } })
    const queued = iterator.next()
    const update = await remote.waitForStat(2)
    expect(update).toMatchObject({ sessionId: SESSION, path: RELATIVE })
    update.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'read-v2', bytes: 10 } })
    await expect(queued).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'read-v2', bytes: 10 } } })
    source.end()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await changes.settle()
    expect(remote.stats).toHaveLength(3)
    expect(remote.opened).toHaveLength(1)
  })

  it('drops a late stat after abort and waits for target stream disposal', async () => {
    const { remote, changes, open } = harness()
    const { iterator, controller } = open()
    const first = iterator.next()
    const { source } = await remote.ready(0)
    const request = await remote.waitForStat(0)
    await source.deliver({ kind: 'change', change: { absolutePath: CANONICAL, version: 'v1' } })
    const gate = remote.holdDisposal()
    controller.abort()
    await remote.waitForDispose(0)
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v0' } })
    await expect(first).resolves.toEqual({ done: true, value: undefined })
    expect(source.aborted).toBe(true)
    let settled = false
    const closing = changes.settle().then(() => { settled = true })
    await remote.waitForStreamEnd(0)
    expect(settled).toBe(false)
    gate.resolve(undefined)
    await closing
    expect(settled).toBe(true)
    expect(remote.disposed).toEqual(['workspace file changes of ' + SESSION])
  })

  it('aborts while waiting for the same target predecessor to close without sending a stat', async () => {
    const { remote, changes, open } = harness()
    const previous = open()
    const first = previous.iterator.next()
    await remote.ready(0)
    const request = await remote.waitForStat(0)
    request.resolve({ ok: true, value: { absolutePath: CANONICAL, version: 'v0' } })
    await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: { absolutePath: CANONICAL, version: 'v0' } } })
    const gate = remote.holdDisposal()
    previous.controller.abort()
    await remote.waitForDispose(0)
    const next = open()
    const pending = next.iterator.next()
    next.controller.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(remote.stats).toHaveLength(1)
    expect(remote.opened).toHaveLength(1)
    gate.resolve(undefined)
    await changes.settle()
    expect(remote.disposed).toHaveLength(2)
  })

  it.each([true, false])('releases an unconsumed notification follower after the first stat (success: %s)', async (ok) => {
    const { remote, changes, open } = harness()
    const { iterator } = open()
    const first = iterator.next()
    const { source } = await remote.ready(0)
    const request = await remote.waitForStat(0)
    const result: RemoteResult<WorkspaceFileStat> = ok
      ? { ok: true, value: { absolutePath: CANONICAL, version: 'v0' } }
      : { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path: RELATIVE }) }
    request.resolve(result)
    await expect(first).resolves.toEqual({ done: false, value: result })
    await iterator.return?.()
    await changes.settle()
    expect(source.aborted).toBe(true)
    expect(remote.disposed).toEqual(['workspace file changes of ' + SESSION])
  })
})
