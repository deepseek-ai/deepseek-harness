/** `/side` forks a started source at its newest durable event, opens the child beside the on-screen Session, and reports outcomes once. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SidechatControl } from '../src/client/control.ts'
import { sidechatAddress } from '../src/client/resource.ts'

const SOURCE = 'session-source' as SessionId
const MAIN = 'session-main' as SessionId
const CHILD = 'session-child' as SessionId

function durable(seq: number, event: Omit<SessionEvent<'turn/start'>, 'seq' | 'time'>): SessionEventLikeEntry {
  return { type: 'event', event: { ...event, seq: SessionSeq(seq), time: seq } }
}

function transient(seq: number): SessionEventLikeEntry {
  const event: Extract<SessionEventLikeEntry, { type: 'transient' }>['event'] = {
    type: 'assistant/live-chunk', seq, time: seq,
    data: { attemptId: 'attempt-1' as never, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } },
  }
  return { type: 'transient', event }
}

interface ForkCall { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean | undefined; onCreated?: (id: SessionId) => void }

const STARTED: SessionEventWindow = (() => {
  const entries = [durable(0, { type: 'turn/start', data: { turn: 1 } })]
  return { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
})()

function harness(window: SessionEventWindow | null = STARTED, mounted: SessionId | null = MAIN, origin?: 'subagent') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const forks: ForkCall[] = []
  const opened: { main: SessionId; address: string }[] = []
  const fork = vi.fn((opts: ForkCall) => {
    forks.push({ sessionId: opts.sessionId, increaseTitle: opts.increaseTitle, ...('atSeq' in opts ? { atSeq: opts.atSeq } : {}) })
    opts.onCreated?.(CHILD)
    return Promise.resolve(CHILD)
  })
  ctx.provide('sessions', {
    list: createSnapshotStore({ ids: [SOURCE], byId: { [SOURCE]: { id: SOURCE, ...(origin === undefined ? {} : { origin }) } } }),
    binding: (id: SessionId) => id === SOURCE && window !== null
      ? { sessionId: id, eventSource: { getSnapshot: () => window, subscribe: () => () => {} } }
      : undefined,
    fork,
  })
  ctx.provide('sidebarRight', {
    mounted: createSnapshotStore<SessionId | undefined>(mounted ?? undefined),
    openResourceIn: (main: SessionId, address: string) => { opened.push({ main, address }) },
  })
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  return { control: new SidechatControl(ctx), fork, forks, opened, error }
}

describe('SidechatControl.fork', () => {
  it('cuts at the newest durable event on screen, skipping live chunk rows', async () => {
    const entries = [
      durable(0, { type: 'turn/start', data: { turn: 1 } }),
      durable(1, { type: 'turn/start', data: { turn: 1 } }),
      transient(1.5),
    ]
    const { control, forks, opened } = harness({ entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } })
    control.fork(SOURCE)
    await vi.waitFor(() => { expect(opened).toHaveLength(1) })
    expect(forks).toEqual([{ sessionId: SOURCE, atSeq: 1, increaseTitle: true }])
    expect(opened).toEqual([{ main: MAIN, address: sidechatAddress(CHILD) }])
  })

  it.each([
    { name: 'no retained event window', window: null },
    { name: 'only configuration events before the first Turn', window: ((): SessionEventWindow => {
      const entries: SessionEventLikeEntry[] = [{ type: 'event', event: { type: 'approval/policy', seq: SessionSeq(0), time: 0, data: { policy: 'ask' } } }]
      return { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
    })() },
  ])('reports that there is nothing to branch with $name', ({ window }) => {
    const { control, forks } = harness(window)
    control.fork(SOURCE)
    expect(forks).toEqual([])
    expect(control.notice.getSnapshot()).toEqual({ serial: 1, key: 'noTurn' })
  })

  it('declines a subagent source with a notice', () => {
    const { control, forks } = harness(STARTED, MAIN, 'subagent')
    control.fork(SOURCE)
    expect(forks).toEqual([])
    expect(control.notice.getSnapshot()).toEqual({ serial: 1, key: 'subagentSource' })
  })

  it('treats a window with older pages as inside a Turn even when the page shows no turn/start', async () => {
    const entries = [durable(7, { type: 'step/end', data: { turn: 1, step: 3 } } as never)]
    const { control, forks, opened } = harness({ entries, hasMore: true, revision: 1, change: { kind: 'replace', entries } })
    control.fork(SOURCE)
    await vi.waitFor(() => { expect(opened).toHaveLength(1) })
    expect(forks).toEqual([{ sessionId: SOURCE, atSeq: 7, increaseTitle: true }])
  })

  it('forks on every call and never without a mounted Session', async () => {
    const h = harness()
    h.control.fork(SOURCE)
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.opened).toHaveLength(2) })
    expect(h.fork).toHaveBeenCalledTimes(2)
    const none = harness(STARTED, null)
    none.control.fork(SOURCE)
    expect(none.fork).not.toHaveBeenCalled()
  })

  it('reports a failed creation as a dismissable notice and logs it', async () => {
    const h = harness()
    h.fork.mockRejectedValueOnce(new Error('Connection lost'))
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.control.notice.getSnapshot()).toEqual({ serial: 1, key: 'createFailed' }) })
    expect(h.error).toHaveBeenCalledWith('Side conversation creation failed', expect.any(Error))
    expect(h.opened).toEqual([])
    h.control.dismiss()
    expect(h.control.notice.getSnapshot()).toBeNull()
    h.fork.mockRejectedValueOnce(new Error('Connection lost'))
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.control.notice.getSnapshot()).toEqual({ serial: 2, key: 'createFailed' }) })
  })

  it('opens a created child whose title rename failed, without a notice', async () => {
    const h = harness()
    h.fork.mockImplementation(async (opts) => { opts.onCreated?.(CHILD); throw new Error('rename failed') })
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.opened).toEqual([{ main: MAIN, address: sidechatAddress(CHILD) }]) })
    expect(h.control.notice.getSnapshot()).toBeNull()
    expect(h.error).toHaveBeenCalledWith('Side conversation title rename failed', expect.any(Error))
  })

  it('neither opens nor reports after disposal', async () => {
    const h = harness()
    const slow = Promise.withResolvers<SessionId>()
    h.fork.mockImplementation(async (opts) => { opts.onCreated?.(CHILD); return slow.promise })
    h.control.fork(SOURCE)
    h.control.dispose()
    h.control.fork(MAIN)
    expect(h.fork).toHaveBeenCalledTimes(1)
    slow.resolve(CHILD)
    await vi.waitFor(() => { expect(h.fork.mock.results[0]?.type).toBe('return') })
    await Promise.resolve()
    expect(h.opened).toEqual([])
    const failing = harness()
    failing.fork.mockImplementation(async () => { failing.control.dispose(); throw new Error('late') })
    failing.control.fork(SOURCE)
    await vi.waitFor(() => { expect(failing.error).toHaveBeenCalled() })
    expect(failing.control.notice.getSnapshot()).toBeNull()
  })
})
