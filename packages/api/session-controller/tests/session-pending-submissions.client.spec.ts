/** Local submission echoes: synchronous insertion, observed/failed retirement, and settlement callbacks. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Session } from '../src/client/sessions/session.ts'
import type { PendingSubmissionRetirement } from '../src/client/contract/session.ts'
import type { SessionQueuedItem, SessionRequestId } from '../src/types.ts'
import { FakeApiClient, err, fakeRemote, ok } from './fake-api.client.ts'
import { historyValue } from './event-script.client.ts'

const SID = 'fk-s1' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeSession(api = new FakeApiClient()): { api: FakeApiClient; session: Session } {
  return { api, session: new Session(SID, fakeRemote(api)) }
}

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: id,
    mediaType: 'image/png',
    bytes: 1,
    width: 2,
    height: 2,
  } as unknown as ImageAttachmentRef
}

function fileRef(id: string, name = 'notes.txt'): FileAttachmentRef {
  return { attachmentId: id, name, bytes: 3 } as unknown as FileAttachmentRef
}

type AttachmentRef = ImageAttachmentRef | FileAttachmentRef

function attachmentBlock(attachment: AttachmentRef) {
  return 'mediaType' in attachment
    ? { type: 'image' as const, attachment }
    : { type: 'file' as const, attachment }
}

/** A durable browser-prompt user/message whose source echoes `rpcId`. */
function promptEvent(seq: SessionSeq, rpcId: SessionRequestId, refs: readonly AttachmentRef[] = []): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: createUserMessage({
      content: [
        ...refs.map(attachmentBlock),
        { type: 'text' as const, text: '发送' },
      ],
      source: { kind: 'user', rpcId },
    }),
  } as unknown as SessionEvent
}

function queuedItem(rpcId: SessionRequestId, refs: readonly AttachmentRef[] = []): SessionQueuedItem {
  return {
    id: 'm-queued' as SessionQueuedItem['id'],
    placement: 'queued',
    rpcId,
    message: {
      id: 'm-queued' as SessionQueuedItem['id'],
      content: refs.map(attachmentBlock) as unknown as SessionQueuedItem['message']['content'],
    },
  }
}

/** Let the frame-delayed retirement (setTimeout fallback in this node environment) run. */
function settleFrames(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('beginSubmission', () => {
  it('inserts the echo synchronously and flips the engaging edge before any prompt call', () => {
    const { session } = makeSession()
    expect(session.getSnapshot()).toMatchObject({ pendingSubmissions: [], promptAttempted: false })
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '你好',
      attachments: [{
        type: 'image', value: { previewUrl: 'blob:p1', name: 'a.png', width: 4, height: 3 },
      }],
    })
    expect(session.getSnapshot().promptAttempted).toBe(true)
    expect(session.getSnapshot().pendingSubmissions).toMatchObject([{
      requestId: handle.requestId,
      placement: 'transcript',
      text: '你好',
      attachments: [{
        type: 'image', value: { previewUrl: 'blob:p1', name: 'a.png', width: 4, height: 3 },
      }],
    }])
  })

  it('derives and captures the echo placement from running state and delivery mode', () => {
    const { session } = makeSession()
    session.beginSubmission({ mode: 'queue', text: '空闲', attachments: [] })
    session.handleRunning(true)
    session.beginSubmission({ mode: 'queue', text: '排队', attachments: [] })
    session.beginSubmission({ mode: 'steer', text: '纠偏', attachments: [] })
    session.handleRunning(false)
    expect(session.getSnapshot().pendingSubmissions.map(({ text, placement }) => ({ text, placement }))).toEqual([
      { text: '空闲', placement: 'transcript' },
      { text: '排队', placement: 'queued' },
      { text: '纠偏', placement: 'steering' },
    ])
  })

  it('abandon retires the echo as failed exactly once', () => {
    const { session } = makeSession()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '放弃',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    handle.abandon()
    handle.abandon()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'failed' }])
  })
})

describe('prompt-coupled retirement', () => {
  it('a rejected identified prompt retires its echo immediately alongside promptError', async () => {
    const { api, session } = makeSession()
    api.onPrompt = () => Promise.resolve(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '失败的',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const result = await session.prompt([{ type: 'text', text: '失败的' }], 'queue', undefined, handle.requestId)
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send' })
    expect(retirements).toEqual([{ reason: 'failed' }])
  })

  it('sends the echo identity as the prompt requestId', async () => {
    const { api, session } = makeSession()
    const handle = session.beginSubmission({ mode: 'queue', text: '带 id', attachments: [] })
    await session.prompt([{ type: 'text', text: '带 id' }], 'queue', undefined, handle.requestId)
    expect(api.callsOf('session.prompt')).toMatchObject([{ requestId: handle.requestId }])
  })

  it('an unidentified prompt failure leaves registered echoes alone', async () => {
    const { api, session } = makeSession()
    api.onPrompt = () => Promise.resolve(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    session.beginSubmission({ mode: 'queue', text: '还在', attachments: [] })
    await session.prompt([{ type: 'text', text: '另一个' }], 'queue')
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
  })
})

describe('observed retirement', () => {
  it('a live durable event carrying the rpcId retires the echo one frame later with the admitted refs', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '发送',
      attachments: [{ type: 'image', value: { previewUrl: 'blob:p1' } }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-1')]
    await api.pushFollow(SID, { type: 'event', event: promptEvent(SessionSeq(0), handle.requestId, refs) as never })
    // Synchronously after the append the echo is still in the snapshot; the
    // render-time dedupe owns the overlap frame.
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('a queue occurrence carrying the rpcId retires the echo (running-turn submissions)', async () => {
    const { session } = makeSession()
    const retirements: PendingSubmissionRetirement[] = []
    session.handleRunning(true)
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '排队',
      attachments: [{ type: 'image', value: { previewUrl: 'blob:p1' } }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-q')]
    session.handleControlFrame({ type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId, refs)] })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
    // The queue projection keeps the correlation id for render-time dedupe.
    expect(session.getSnapshot().queue).toMatchObject([{ rpcId: handle.requestId }])
  })

  it('retires a mixed echo with durable references in original selection order', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const file = fileRef('file-1')
    const handle = session.beginSubmission({
      mode: 'queue',
      text: 'mixed',
      attachments: [
        { type: 'image', value: { previewUrl: 'blob:first' } },
        { type: 'file', value: file },
        { type: 'image', value: { previewUrl: 'blob:last' } },
      ],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('image-1'), file, imageRef('image-2')]
    await api.pushFollow(SID, { type: 'event', event: promptEvent(SessionSeq(0), handle.requestId, refs) as never })
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('a full-window install (reconnect resync) retires echoes observed in the window', async () => {
    const { api, session } = makeSession()
    const handle = session.beginSubmission({ mode: 'queue', text: '重连', attachments: [] })
    api.onHistory = () => Promise.resolve(ok(historyValue([promptEvent(SessionSeq(12), handle.requestId)])))
    await session.open()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('the first observation wins: a later prompt failure cannot re-retire an observed echo', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '先观察',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    await api.pushFollow(SID, { type: 'event', event: promptEvent(SessionSeq(0), handle.requestId) as never })
    handle.abandon()
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
  })

  it('retires once when the queue and durable event report the same request id', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '同一请求',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    session.handleControlFrame({
      type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId, [])],
    })
    await api.pushFollow(SID, {
      type: 'event', event: promptEvent(SessionSeq(0), handle.requestId) as never,
    })
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('uses requestAnimationFrame for the retirement delay when the runtime provides one', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      frames.push(fn)
      return frames.length
    })
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const handle = session.beginSubmission({ mode: 'queue', text: '帧', attachments: [] })
    await api.pushFollow(SID, { type: 'event', event: promptEvent(SessionSeq(0), handle.requestId) as never })
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(frames).toHaveLength(1)
    frames[0]?.(0)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})

describe('disposal', () => {
  it('retires unsettled echoes as failed and preserves an already-observed settlement', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: { text: string; retirement: PendingSubmissionRetirement }[] = []
    const observed = session.beginSubmission({
      mode: 'queue',
      text: '已观察',
      attachments: [],
      onRetire: retirement => retirements.push({ text: '已观察', retirement }),
    })
    session.beginSubmission({
      mode: 'queue',
      text: '未settle',
      attachments: [],
      onRetire: retirement => retirements.push({ text: '未settle', retirement }),
    })
    await api.pushFollow(SID, { type: 'event', event: promptEvent(SessionSeq(0), observed.requestId) as never })
    await session.dispose()
    await settleFrames()
    expect(retirements).toEqual([
      { text: '未settle', retirement: { reason: 'failed' } },
      { text: '已观察', retirement: { reason: 'observed', attachments: [] } },
    ])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})
