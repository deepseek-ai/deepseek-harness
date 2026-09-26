/**
 * Local submission echoes: synchronous insertion, observed/failed retirement,
 * and settlement callbacks. Prompts and the follow stream cross the assembled
 * Gateway client and are answered by endpoint name.
 */

import { afterEach, describe, expect, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { PendingSubmissionRetirement } from '../src/client/contract/session.ts'
import type { SessionRequestId } from '../src/types.ts'
import { ev, historyValue } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import {
  FOLLOW, err, fileRef, followScript, history, imageRef, pushEvent,
} from './remote/session.client.ts'

/** A Session talks through the Gateway client; its dependency cone is the Typert registry and the Connection. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })
const SID = 'fk-s1' as SessionId
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

afterEach(() => {
  vi.unstubAllGlobals()
})

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

function queuedItem(rpcId: SessionRequestId, refs: readonly AttachmentRef[] = []) {
  return createUserMessage({
    source: { kind: 'user', rpcId },
    content: refs.map(attachmentBlock),
  })
}

/** Let the frame-delayed retirement (setTimeout fallback in this node environment) run. */
async function settleFrames(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('beginSubmission', () => {
  it('inserts the echo synchronously and flips the engaging edge before any prompt call', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
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
    expect(mock.log.requests()).toEqual([])
  }, COLD_BOOT_TIMEOUT_MS)

  it('derives and captures the echo placement from running state and delivery mode', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
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

  it('keeps rapid ordinary submissions in Chat until the running update arrives', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    for (const text of ['A', 'B', 'C']) session.beginSubmission({ mode: 'queue', text, attachments: [] })
    expect(session.getSnapshot().pendingSubmissions.map(input => input.placement)).toEqual([
      'transcript', 'transcript', 'transcript',
    ])
    session.handleRunning(true)
    session.beginSubmission({ mode: 'queue', text: 'D', attachments: [] })
    expect(session.getSnapshot().pendingSubmissions.map(input => input.placement)).toEqual([
      'transcript', 'transcript', 'transcript', 'queued',
    ])
  })

  it('abandon retires the echo as failed exactly once', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
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
  it('a rejected identified prompt retires its echo immediately alongside promptError', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.prompt.mockResolvedValue(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
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
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'session/agent-busy' } })
    expect(retirements).toEqual([{ reason: 'failed' }])
  })

  it('sends the echo identity as the prompt requestId', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const handle = session.beginSubmission({ mode: 'queue', text: '带 id', attachments: [] })
    await session.prompt([{ type: 'text', text: '带 id' }], 'queue', undefined, handle.requestId)
    expect(mock.log.requests('session/prompt')).toMatchObject([{ requestId: handle.requestId, sessionId: SID }])
  })

  it('an unidentified prompt failure leaves registered echoes alone', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.prompt.mockResolvedValue(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    session.beginSubmission({ mode: 'queue', text: '还在', attachments: [] })
    await session.prompt([{ type: 'text', text: '另一个' }], 'queue')
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
  })
})

describe('observed retirement', () => {
  it('a live durable event carrying the rpcId retires the echo one frame later with the admitted refs', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '发送',
      attachments: [{ type: 'image', value: { previewUrl: 'blob:p1' } }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-1')]
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId, refs))
    // Synchronously after the append the echo is still in the snapshot; the
    // render-time dedupe owns the overlap frame.
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('retains an idle echo when a claim clears the projection before its notification', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const onRetire = vi.fn()
    const handle = session.beginSubmission({ mode: 'steer', text: 'accepted', attachments: [], onRetire })
    const refs = [imageRef('claimed-image')]
    const message = queuedItem(handle.requestId, refs)
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [message] }, SessionSeq(0))
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(1))
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(onRetire).not.toHaveBeenCalled()
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, promptEvent(SessionSeq(2), handle.requestId, refs))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
  })

  for (const { mode, target, order } of [
    { mode: 'queue', target: 'next-turn', order: 'inbox-first' },
    { mode: 'queue', target: 'next-turn', order: 'transcript-first' },
    { mode: 'steer', target: 'next-step', order: 'inbox-first' },
    { mode: 'steer', target: 'next-step', order: 'transcript-first' },
  ] as const) {
    it(`keeps a ${mode} Chat identity until admission and the Inbox claim watermark (${order})`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, -1)
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
      const onRetire = vi.fn()
      session.handleRunning(mode === 'steer')
      const handle = session.beginSubmission({ mode, text: 'local input', attachments: [], onRetire })
      const refs = [imageRef('idle-image'), fileRef('idle-file')]
      const message = queuedItem(handle.requestId, refs)
      const queued = { 'next-turn': [], 'next-step': [], [target]: [message] }
      const empty = { 'next-turn': [], 'next-step': [] }
      if (order === 'inbox-first') session.projections.apply('inbox', queued, SessionSeq(0))
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target, start: 0, inserted: [message] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target, start: 0, removedCount: 1, inserted: [] },
      })
      expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
      expect(frames).toHaveLength(0)
      if (order === 'inbox-first') session.projections.apply('inbox', empty, SessionSeq(1))
      await pushEvent(mock, promptEvent(SessionSeq(2), handle.requestId, refs))
      if (order === 'transcript-first') {
        await pushEvent(mock, ev.turnEnd(SessionSeq(3), 1))
        handle.abandon()
        session.projections.apply('inbox', queued, SessionSeq(0))
        await Promise.resolve()
        expect(frames).toHaveLength(0)
        expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
        expect(onRetire).not.toHaveBeenCalled()
        session.projections.apply('inbox', empty, SessionSeq(1))
        await Promise.resolve()
      }
      expect(frames).toHaveLength(1)
      frames[0]?.(0)
      expect(session.getSnapshot().pendingSubmissions).toEqual([])
      expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
      session.projections.apply('inbox', queued, SessionSeq(0))
      expect(session.projections.get('inbox')).toEqual(empty)
    })
  }

  for (const projectionFirst of [true, false]) {
    it(`settles overlapping opening, queued and steering inputs independently (${projectionFirst ? 'projection' : 'history'} first)`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
      const flush = () => { for (const callback of frames.splice(0)) callback(0) }
      const normalRetired = vi.fn()
      const queueRetired = vi.fn()
      const steerRetired = vi.fn()
      const normal = session.beginSubmission({ mode: 'queue', text: 'opening', attachments: [], onRetire: normalRetired })
      session.handleRunning(true)
      const queued = session.beginSubmission({ mode: 'queue', text: 'queued', attachments: [], onRetire: queueRetired })
      const steer = session.beginSubmission({ mode: 'steer', text: 'steering', attachments: [], onRetire: steerRetired })
      const normalMessage = queuedItem(normal.requestId, [fileRef('opening-file')])
      const queuedMessage = queuedItem(queued.requestId, [imageRef('queued-image')])
      const steerMessage = queuedItem(steer.requestId, [imageRef('steer-image'), fileRef('steer-file')])
      const pending = () => session.getSnapshot().pendingSubmissions.map(input => input.text)
      const accepted = { 'next-turn': [normalMessage, queuedMessage], 'next-step': [steerMessage] }
      if (projectionFirst) session.projections.apply('inbox', accepted, SessionSeq(1))
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target: 'next-turn', start: 0, inserted: [normalMessage, queuedMessage] } })
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target: 'next-step', start: 0, inserted: [steerMessage] } })
      flush()
      expect(pending()).toEqual(['opening', 'steering'])
      expect(queueRetired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [imageRef('queued-image')] })
      await pushEvent(mock, ev.turnStart(SessionSeq(2), 1))
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 4,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } })
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(4), time: 5,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      const claimed = { 'next-turn': [queuedMessage], 'next-step': [] }
      if (projectionFirst) session.projections.apply('inbox', claimed, SessionSeq(4))
      await pushEvent(mock, ev.stepStart(SessionSeq(5), 1, 1))
      await pushEvent(mock, { type: 'user/message', seq: SessionSeq(6), time: 7, surfaceOp: 'append', data: steerMessage })
      flush()
      expect(pending()).toEqual(projectionFirst ? ['opening'] : ['opening', 'steering'])
      expect(normalRetired).not.toHaveBeenCalled()
      if (!projectionFirst) expect(steerRetired).not.toHaveBeenCalled()
      await pushEvent(mock, { type: 'user/message', seq: SessionSeq(7), time: 8, surfaceOp: 'append', data: normalMessage })
      flush()
      if (!projectionFirst) {
        expect(pending()).toEqual(['opening', 'steering'])
        session.projections.apply('inbox', accepted, SessionSeq(1))
        flush()
        expect(normalRetired).not.toHaveBeenCalled()
        session.projections.apply('inbox', claimed, SessionSeq(4))
        await Promise.resolve()
        flush()
      }
      expect(pending()).toEqual([])
      expect(normalRetired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [fileRef('opening-file')] })
      expect(steerRetired).toHaveBeenCalledExactlyOnceWith({
        reason: 'observed', attachments: [imageRef('steer-image'), fileRef('steer-file')],
      })
      await pushEvent(mock, ev.stepEnd(SessionSeq(8), 1, 1))
      await pushEvent(mock, ev.turnEnd(SessionSeq(9), 1))
      await pushEvent(mock, ev.turnStart(SessionSeq(10), 2))
      await pushEvent(mock, { type: 'agent/inbox/spliced', seq: SessionSeq(11), time: 12,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      await pushEvent(mock, ev.stepStart(SessionSeq(12), 2, 2))
      await pushEvent(mock, { type: 'user/message', seq: SessionSeq(13), time: 14, surfaceOp: 'append', data: queuedMessage })
      session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(11))
      flush()
      expect(queueRetired).toHaveBeenCalledTimes(1)
      expect(pending()).toEqual([])
    })
  }

  it('keeps a running steer echo through accepted and claimed Inbox states until transcript admission', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    session.handleRunning(true)
    const onRetire = vi.fn()
    const handle = session.beginSubmission({ mode: 'steer', text: 'accepted', attachments: [], onRetire })
    const refs = [imageRef('steer-image')]
    const message = queuedItem(handle.requestId, refs)
    const echo = session.getSnapshot().pendingSubmissions[0]
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [message] }, SessionSeq(0))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([echo])
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
    })
    session.projections.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(1))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([echo])
    expect(onRetire).not.toHaveBeenCalled()
    await pushEvent(mock, {
      type: 'user/message', seq: SessionSeq(2), time: 3, surfaceOp: 'append', data: message,
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
  })

  for (const target of ['next-step', 'next-turn'] as const) {
    it(`retires canceled or unadmitted ${target} input without removing still-pending input`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      session.handleRunning(target === 'next-step')
      const canceled = vi.fn()
      const rejected = vi.fn()
      const first = session.beginSubmission({ mode: 'steer', text: 'cancel', attachments: [], onRetire: canceled })
      const second = session.beginSubmission({ mode: 'steer', text: 'reject', attachments: [], onRetire: rejected })
      const unclaimed = session.beginSubmission({ mode: 'steer', text: 'later', attachments: [] })
      const foreign = createUserMessage({ source: { kind: 'user' }, content: [] })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target, start: 0, inserted: [queuedItem(first.requestId), queuedItem(second.requestId)] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target, start: 0, inserted: [foreign] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
        data: { target, start: 1, removedCount: 1, inserted: [], outcome: 'canceled' },
      })
      expect(canceled).toHaveBeenCalledExactlyOnceWith({ reason: 'failed' })
      expect(rejected).not.toHaveBeenCalled()
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 4,
        data: { target, start: 0, removedCount: 2, inserted: [] },
      })
      await pushEvent(mock, {
        type: 'agent/inbox/spliced', seq: SessionSeq(4), time: 5,
        data: { target, start: 0, inserted: [queuedItem(unclaimed.requestId)] },
      })
      await pushEvent(mock, {
        type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'blocked' } },
      })
      expect(rejected).toHaveBeenCalledExactlyOnceWith({ reason: 'failed' })
      expect(session.getSnapshot().pendingSubmissions.map(echo => echo.requestId)).toEqual([unclaimed.requestId])
    })
  }

  it('a queue occurrence carrying the rpcId retires the echo (running-turn submissions)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const retirements: PendingSubmissionRetirement[] = []
    session.handleRunning(true)
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '排队',
      attachments: [{ type: 'image', value: { previewUrl: 'blob:p1' } }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-q')]
    session.projections.apply('inbox', { 'next-turn': [queuedItem(handle.requestId, refs)], 'next-step': [] }, SessionSeq(1))
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
    // The queue projection keeps the correlation id for render-time dedupe.
    expect(session.projections.get('inbox')).toMatchObject({
      'next-turn': [{ source: { rpcId: handle.requestId } }],
    })
  })

  it('retires a mixed echo with durable references in original selection order', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
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
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId, refs))
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('a full-window install (reconnect resync) retires echoes observed in the window', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const handle = session.beginSubmission({ mode: 'queue', text: '重连', attachments: [] })
    mock.stream(FOLLOW, followScript(history([promptEvent(SessionSeq(12), handle.requestId)])))
    await session.open()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  for (const [target, pending] of [
    ['next-step', false], ['next-step', true], ['next-turn', false], ['next-turn', true],
  ] as const) {
    it(`retires confirmed ${target} input on resync with the Host input ${pending ? 'still pending' : 'outside the history window'}`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID)
      await session.open()
      session.handleRunning(target === 'next-step')
      const onRetire = vi.fn()
      const handle = session.beginSubmission({ mode: 'steer', text: 'accepted', attachments: [], onRetire })
      const refs = [imageRef('steer-image'), fileRef('steer-file')]
      const message = queuedItem(handle.requestId, refs)
      if (target === 'next-turn') {
        session.projections.apply('inbox', { 'next-turn': [message], 'next-step': [] }, SessionSeq(0))
        await Promise.resolve()
      } else {
        await pushEvent(mock, {
          type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
          data: { target, start: 0, inserted: [message] },
        })
      }
      const unconfirmed = session.beginSubmission({ mode: 'steer', text: 'not accepted yet', attachments: [] })
      const inbox = { 'next-turn': [], 'next-step': [], [target]: pending ? [message] : [] }
      const replacement = {
        ...historyValue([ev.turnEnd(SessionSeq(10), 2)], true),
        projections: { asOfSeq: 10, values: { inbox } },
      }
      mock.stream(FOLLOW, followScript({ ok: true, value: replacement }))
      await session.resync()
      await settleFrames()

      expect(session.getSnapshot().pendingSubmissions.map(item => item.requestId)).toEqual([unconfirmed.requestId])
      expect(session.projections.get('inbox')).toEqual(inbox)
      expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
      await pushEvent(mock, ev.turnEnd(SessionSeq(11), 3))
      expect(onRetire).toHaveBeenCalledTimes(1)
    })
  }

  it('withdraws a confirmed optimistic steer when resync lands between claim and admission', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    session.handleRunning(true)
    const onRetire = vi.fn()
    const handle = session.beginSubmission({ mode: 'steer', text: 'accepted', attachments: [], onRetire })
    const refs = [imageRef('claimed-image')]
    const message = queuedItem(handle.requestId, refs)
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [message] },
    })
    const replacement = {
      ...historyValue([{
        type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
        data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      }], true),
      projections: { asOfSeq: 1, values: { inbox: { 'next-turn': [], 'next-step': [] } } },
    }
    mock.stream(FOLLOW, followScript({ ok: true, value: replacement }))
    await session.resync()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })

    const admitted = promptEvent(SessionSeq(2), handle.requestId, refs)
    await pushEvent(mock, admitted)
    await settleFrames()
    expect(session.eventSource.getSnapshot().entries.at(-1)?.event).toEqual(admitted)
    expect(onRetire).toHaveBeenCalledTimes(1)
  })

  it('the first observation wins: a later prompt failure cannot re-retire an observed echo', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '先观察',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    handle.abandon()
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
  })

  it('retires once when the queue and durable event report the same request id', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      mode: 'queue',
      text: '同一请求',
      attachments: [],
      onRetire: retirement => retirements.push(retirement),
    })
    session.projections.apply('inbox', { 'next-turn': [queuedItem(handle.requestId, [])], 'next-step': [] }, SessionSeq(1))
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('uses requestAnimationFrame for the retirement delay when the runtime provides one', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      frames.push(fn)
      return frames.length
    })
    const handle = session.beginSubmission({ mode: 'queue', text: '帧', attachments: [] })
    await pushEvent(mock, promptEvent(SessionSeq(0), handle.requestId))
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(frames).toHaveLength(1)
    frames[0]?.(0)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})

describe('disposal', () => {
  it('settles an admitted transcript as observed when disposed before the Inbox watermark arrives', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.open()
    const onRetire = vi.fn()
    const handle = session.beginSubmission({ mode: 'queue', text: 'admitted', attachments: [], onRetire })
    const refs = [imageRef('held-image')]
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [queuedItem(handle.requestId, refs)] },
    })
    await pushEvent(mock, {
      type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    })
    await pushEvent(mock, promptEvent(SessionSeq(2), handle.requestId, refs))
    expect(onRetire).not.toHaveBeenCalled()
    await session.dispose()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: refs })
  })

  it('retires unsettled echoes as failed and preserves an already-observed settlement', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
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
    await pushEvent(mock, promptEvent(SessionSeq(0), observed.requestId))
    await session.dispose()
    await settleFrames()
    expect(retirements).toEqual([
      { text: '未settle', retirement: { reason: 'failed' } },
      { text: '已观察', retirement: { reason: 'observed', attachments: [] } },
    ])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})
