/**
 * Queue snapshot semantics: authoritative replacement after every host-side
 * change, reconnect re-baselining, pre-instantiation buffering, editable-text
 * projection, and snapshot reference stability.
 */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MessageId, RpcId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { Session } from '../src/client/sessions/session.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

const SID = 'fk-q1' as SessionId
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const rid = (id: string): RpcId => id as RpcId
const iid = (id: string): MessageId => id as MessageId

interface QueueFixture {
  id: string
  body: string
  content?: ContentBlock[]
  placement?: 'queued' | 'steering'
  message?: UserMessage
}

/** Build one authoritative queue snapshot. */
function queueFrame(items: QueueFixture[]): Extract<SessionControlFrame, { type: 'queue' }> {
  return {
    type: 'queue',
    sessionId: SID,
    items: items.map(item => ({
      id: iid(item.id),
      placement: item.placement ?? 'queued',
      message: (item.message ?? createUserMessage({
        content: item.content ?? text(item.body),
        source: { kind: 'user', rpcId: rid(`rpc-${item.id}`) } as never,
      })) as never,
    })),
  }
}

function makeSession(): Session {
  return makeBench().session
}

function makeBench(): { api: FakeApiClient; session: Session } {
  const api = new FakeApiClient()
  return { api, session: new Session(SID, fakeRemote(api)) }
}

function makeManager(): SessionManager {
  const api = new FakeApiClient()
  return new SessionManager(fakeRemote(api))
}

describe('Session queue snapshot intake', () => {
  it('projects stable ids, flat previews, and complete text', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([
      { id: 'q-1', body: '第一条  排队\n消息' },
    ]))
    const queue = session.getSnapshot().queue
    expect(typeof queue[0]?.messageId).toBe('string')
    expect(queue).toMatchObject([
      {
        id: 'q-1', placement: 'queued',
        content: [{ type: 'text', text: '第一条  排队\n消息' }],
        preview: '第一条 排队 消息', text: '第一条  排队\n消息',
      },
    ])
  })

  it('marks mixed-content messages non-editable and keeps image blocks out of the text preview', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([{
      id: 'q-image',
      body: '',
      content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' } as never],
    }]))
    const queue = session.getSnapshot().queue
    expect(typeof queue[0]?.messageId).toBe('string')
    expect(queue).toMatchObject([
      {
        id: 'q-image', placement: 'queued',
        content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' }],
        // Image blocks render as thumbnails from `content`, so the preview
        // carries only the text; non-image foreign blocks keep their marker.
        preview: 'hi', text: null,
      },
    ])
  })

  it('caps previews at 200 code points and preserves the full editable text', () => {
    const session = makeSession()
    const body = '长'.repeat(201)
    session.handleControlFrame(queueFrame([{ id: 'q-cap', body }]))
    const row = session.getSnapshot().queue[0]
    expect(Array.from(row?.preview ?? '')).toHaveLength(201)
    expect(row?.preview.endsWith('…')).toBe(true)
    expect(row?.text).toBe(body)
  })

  it('replaces content, order, and membership from each authoritative frame', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([
      { id: 'q-1', body: 'one' },
      { id: 'q-2', body: 'two' },
    ]))
    session.handleControlFrame(queueFrame([
      { id: 'q-2', body: 'two edited' },
    ]))
    const queue = session.getSnapshot().queue
    expect(typeof queue[0]?.messageId).toBe('string')
    expect(queue).toMatchObject([
      {
        id: 'q-2', placement: 'queued',
        content: [{ type: 'text', text: 'two edited' }],
        preview: 'two edited', text: 'two edited',
      },
    ])
    session.handleControlFrame(queueFrame([]))
    expect(session.getSnapshot().queue).toEqual([])
  })

  it('keeps the queue array reference stable across unrelated snapshot swaps', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([{ id: 'q-stable', body: '稳定' }]))
    const before = session.getSnapshot().queue
    session.handleAgentError('unrelated')
    expect(session.getSnapshot().queue).toBe(before)
  })

  it('retains steering placement and complete content in the same authoritative snapshot', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([
      { id: 'q-next', body: 'later' },
      { id: 's-now', body: 'interrupt now', placement: 'steering' },
    ]))

    expect(session.getSnapshot().queue.map(item => ({
      id: item.id, placement: item.placement, content: item.content,
    }))).toEqual([
      { id: 'q-next', placement: 'queued', content: text('later') },
      { id: 's-now', placement: 'steering', content: text('interrupt now') },
    ])
  })

  it('hands off exactly one current occurrence when live steering becomes durable', async () => {
    const { api, session } = makeBench()
    await session.open()
    const message = createUserMessage({
      content: text('same message'),
      source: { kind: 'user' },
    })
    session.handleControlFrame(queueFrame([
      { id: 's-first', body: '', placement: 'steering', message },
      { id: 's-second', body: '', placement: 'steering', message },
    ]))
    const durable = {
      seq: SessionSeq(0),
      time: 1_700_000_000_000,
      type: 'user/message',
      surfaceOp: 'append',
      data: message,
    } satisfies SessionEvent

    await api.pushFollow(SID, { type: 'event', event: durable as never })
    await vi.waitFor(() => {
      expect(session.getSnapshot().queue.map(item => item.id)).toEqual(['s-second'])
    })

    session.handleControlFrame(queueFrame([
      { id: 's-later', body: '', placement: 'steering', message },
    ]))
    await api.pushFollow(SID, { type: 'event', event: durable as never })
    await vi.waitFor(() => {
      expect(session.getSnapshot().queue.map(item => item.id)).toEqual(['s-later'])
    })
  })

  it('hands off live steering when the agent claims it as a user message', async () => {
    const { api, session } = makeBench()
    await session.open()
    const message = createUserMessage({
      content: text('claimed steering'),
      source: { kind: 'user' },
    })
    session.handleControlFrame(queueFrame([
      { id: 's-claimed', body: '', placement: 'steering', message },
    ]))

    await api.pushFollow(SID, {
      type: 'event',
      event: {
        seq: 0,
        time: 1_700_000_000_000,
        type: 'user/message',
        surfaceOp: 'append',
        data: message,
      } as never,
    })

    await vi.waitFor(() => {
      expect(session.getSnapshot().queue).toEqual([])
    })
  })
})

describe('queue operation transport', () => {
  it('addresses the session.updateQueue RPC without optimistic local mutation', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    session.handleControlFrame(queueFrame([{ id: 'q-op', body: 'pending' }]))
    const before = session.getSnapshot().queue

    await expect(session.updateQueue(iid('q-op'), { kind: 'edit', content: text('next') }))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(session.updateQueue(iid('q-op'), { kind: 'steer' }))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(api.callsOf('session.updateQueue')).toEqual([
      {
        sessionId: SID,
        itemId: 'q-op',
        action: { kind: 'edit', content: text('next') },
      },
      {
        sessionId: SID,
        itemId: 'q-op',
        action: { kind: 'steer' },
      },
    ])
    expect(session.getSnapshot().queue).toBe(before)
  })
})

describe('queue reconnect semantics', () => {
  it('a control baseline clears stale state before a fresh update lands', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([{ id: 'q-old', body: '旧连接' }]))
    session.replaceControl([])
    expect(session.getSnapshot().queue).toEqual([])
    session.handleControlFrame(queueFrame([{ id: 'q-new', body: '新基线' }]))
    expect(session.getSnapshot().queue.map(row => row.id)).toEqual(['q-new'])
  })

  it('resync does not clear a baseline that raced ahead of the host connection signal', async () => {
    const session = makeSession()
    await session.open()
    session.handleControlFrame(queueFrame([{ id: 'q-fresh', body: '新基线' }]))
    await session.resync()
    expect(session.getSnapshot().queue.map(row => row.id)).toEqual(['q-fresh'])
  })

  it('running-status changes never guess at queue retirement', () => {
    const session = makeSession()
    session.handleControlFrame(queueFrame([{ id: 'q-live', body: '保留' }]))
    session.handleRunning(true)
    session.handleRunning(false)
    expect(session.getSnapshot().queue.map(row => row.id)).toEqual(['q-live'])
  })
})

describe('manager buffering of queue snapshots', () => {
  it('replays only the latest snapshot for an uninstantiated session', () => {
    const manager = makeManager()
    manager.handleControlFrame(queueFrame([{ id: 'q-old', body: '旧' }]))
    manager.handleControlFrame(queueFrame([{ id: 'q-new', body: '新' }]))
    expect(manager.get(SID).getSnapshot().queue.map(row => row.id)).toEqual(['q-new'])
  })

  it('a control baseline replaces the prior queue', () => {
    const manager = makeManager()
    manager.handleControlFrame(queueFrame([{ id: 'q-g1', body: '第一代' }]))
    const nextQueue = queueFrame([{ id: 'q-g2', body: '第二代' }]).items
    manager.handleControlFrame({
      type: 'baseline',
      value: {
        queues: { [SID]: nextQueue },
        jobs: {},
        projections: {},
      },
    })
    const snapshot = manager.get(SID).getSnapshot()
    expect(snapshot.queue.map(row => row.id)).toEqual(['q-g2'])
  })
})
