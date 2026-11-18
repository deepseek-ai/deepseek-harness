import { describe, expect, it, vi } from 'vitest'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createPathPresence, type MentionSessionId, type PathStat } from '../src/client/path-presence.ts'

const sid = (value: string): MentionSessionId => value as MentionSessionId
const STAT: WorkspaceFileStat = { absolutePath: '/w/LICENSE', version: 'v1' }

interface StatCall {
  readonly sessionId: MentionSessionId
  readonly path: string
  readonly signal: AbortSignal
  readonly resolve: (result: RemoteResult<WorkspaceFileStat>) => void
}

function deferredStat() {
  const calls: StatCall[] = []
  const stat = vi.fn<PathStat>((sessionId, path, signal) => new Promise((resolve) => {
    calls.push({ sessionId, path, signal, resolve })
  }))
  return { stat, calls }
}

const failure = (error: RemoteFailure): RemoteResult<WorkspaceFileStat> => ({ ok: false, error })

describe('createPathPresence', () => {
  it('shares one stat per Session and path and publishes the Host answer to every subscriber', async () => {
    const { stat, calls } = deferredStat()
    const presence = createPathPresence(stat)
    const source = presence.source(sid('a'), 'LICENSE')
    expect(presence.source(sid('a'), 'LICENSE')).toBe(source)
    expect(presence.source(sid('b'), 'LICENSE')).not.toBe(source)
    expect(source.getSnapshot()).toBeUndefined()
    expect(stat).not.toHaveBeenCalled()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = source.subscribe(first)
    source.subscribe(second)
    expect(calls.map(call => [call.sessionId, call.path])).toEqual([['a', 'LICENSE']])
    unsubscribe()
    calls[0]!.resolve({ ok: true, value: STAT })
    await vi.waitFor(() => { expect(source.getSnapshot()).toBe('present') })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    source.subscribe(vi.fn())
    expect(stat).toHaveBeenCalledOnce()
  })

  it('treats a non-regular entry as present, a missing entry as absent, and retries any other failure', async () => {
    const { stat, calls } = deferredStat()
    const presence = createPathPresence(stat)
    const folder = presence.source(sid('a'), 'docs/')
    const missing = presence.source(sid('a'), 'ceshi')
    const offline = presence.source(sid('a'), 'notes.md')
    folder.subscribe(vi.fn())
    missing.subscribe(vi.fn())
    offline.subscribe(vi.fn())
    calls[0]!.resolve(failure(new RemoteError('workspace-file/not-regular-file', 'directory', { path: 'docs/', kind: 'directory' })))
    calls[1]!.resolve(failure(new RemoteError('workspace-file/not-found', 'missing', { path: 'ceshi' })))
    calls[2]!.resolve(failure(new RemoteError('gateway/internal', 'offline', {})))
    await vi.waitFor(() => { expect(missing.getSnapshot()).toBe('absent') })
    expect(folder.getSnapshot()).toBe('present')
    expect(offline.getSnapshot()).toBeUndefined()
    offline.subscribe(vi.fn())
    expect(calls.map(call => call.path)).toEqual(['docs/', 'ceshi', 'notes.md', 'notes.md'])
    calls[3]!.resolve({ ok: true, value: STAT })
    await vi.waitFor(() => { expect(offline.getSnapshot()).toBe('present') })
  })

  it('lets a picked confirmation stand over an older outstanding stat and over an earlier absence', async () => {
    const { stat, calls } = deferredStat()
    const presence = createPathPresence(stat)
    const source = presence.source(sid('a'), 'new.md')
    const listener = vi.fn()
    source.subscribe(listener)
    presence.confirm(sid('a'), 'new.md')
    presence.confirm(sid('a'), 'new.md')
    expect(source.getSnapshot()).toBe('present')
    expect(listener).toHaveBeenCalledOnce()
    calls[0]!.resolve(failure(new RemoteError('workspace-file/not-found', 'missing', { path: 'new.md' })))
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot()).toBe('present')

    const created = presence.source(sid('a'), 'later.md')
    created.subscribe(vi.fn())
    calls[1]!.resolve(failure(new RemoteError('workspace-file/not-found', 'missing', { path: 'later.md' })))
    await vi.waitFor(() => { expect(created.getSnapshot()).toBe('absent') })
    presence.confirm(sid('a'), 'later.md')
    expect(created.getSnapshot()).toBe('present')
    const picked = presence.source(sid('a'), 'picked.md')
    presence.confirm(sid('a'), 'picked.md')
    picked.subscribe(vi.fn())
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected stat as an unhandled rejection and asks again for the next subscriber', async () => {
    const fault = new Error('client api: workspaceFiles/stat has no active Connection')
    const stat = vi.fn<PathStat>()
      .mockRejectedValueOnce(fault)
      .mockResolvedValueOnce({ ok: true, value: STAT })
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const presence = createPathPresence(stat)
      const source = presence.source(sid('a'), 'LICENSE')
      source.subscribe(vi.fn())
      await vi.waitFor(() => { expect(rejections).toEqual([fault]) })
      expect(source.getSnapshot()).toBeUndefined()
      source.subscribe(vi.fn())
      expect(stat).toHaveBeenCalledTimes(2)
      await vi.waitFor(() => { expect(source.getSnapshot()).toBe('present') })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('aborts outstanding stats on disposal, drops their answers, and starts no further stats', async () => {
    const { stat, calls } = deferredStat()
    const presence = createPathPresence(stat)
    const source = presence.source(sid('a'), 'LICENSE')
    const listener = vi.fn()
    source.subscribe(listener)
    presence.dispose()
    expect(calls[0]!.signal.aborted).toBe(true)
    calls[0]!.resolve({ ok: true, value: STAT })
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot()).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    presence.source(sid('a'), 'other.md').subscribe(vi.fn())
    expect(stat).toHaveBeenCalledOnce()
  })
})
