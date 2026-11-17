import { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
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

interface ForkCall { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean | undefined }

function harness(window: SessionEventWindow | undefined) {
  const ctx = new Context()
  const forks: ForkCall[] = []
  const opened: { main: SessionId; address: string }[] = []
  ctx.provide('sessions', {
    binding: (id: SessionId) => id === SOURCE && window !== undefined
      ? { sessionId: id, eventSource: { getSnapshot: () => window, subscribe: () => () => {} } }
      : undefined,
    fork: (opts: ForkCall & { onCreated?: (id: SessionId) => void }) => {
      forks.push({ sessionId: opts.sessionId, increaseTitle: opts.increaseTitle, ...('atSeq' in opts ? { atSeq: opts.atSeq } : {}) })
      opts.onCreated?.(CHILD)
      return Promise.resolve(CHILD)
    },
  })
  ctx.provide('sidebarRight', {
    mounted: createSnapshotStore<SessionId | undefined>(MAIN),
    openResourceIn: (main: SessionId, address: string) => { opened.push({ main, address }) },
  })
  return { control: new SidechatControl(ctx), forks, opened }
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

  it('leaves the cut to the Host when the source has no retained event window', async () => {
    const { control, forks, opened } = harness(undefined)
    control.fork(SOURCE)
    await vi.waitFor(() => { expect(opened).toHaveLength(1) })
    expect(forks).toEqual([{ sessionId: SOURCE, increaseTitle: true }])
  })
})
