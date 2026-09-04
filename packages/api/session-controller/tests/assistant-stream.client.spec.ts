import { describe, expect, it } from 'vitest'
import { LlmAttemptId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '../src/types.ts'
import { ClientAssistantStream } from '../src/client/sessions/assistant-stream.ts'
import type { SessionLiveEventEntry } from '../src/client/contract/events.ts'

const ATTEMPT = LlmAttemptId('session:1')

function entry(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

function ordinary(seq: number): SessionLiveEventEntry {
  return entry({ type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: 1 } })
}

function attemptEvent(seq: number, turn = 1, step = 1): SessionLiveEventEntry {
  return entry({
    type: 'assistant/attempt',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn, step, stream: [] },
  })
}

function messageEvent(
  seq: number,
  turn = 1,
  step = 1,
  surfaceOp: 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number } = 'append',
): SessionLiveEventEntry {
  return entry({
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'done' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      stream: [],
    },
    surfaceOp: surfaceOp === 'append'
      ? surfaceOp
      : { ...surfaceOp, start: SessionSeq(surfaceOp.start), end: SessionSeq(surfaceOp.end) },
  })
}

function start(
  attemptId = ATTEMPT,
  startedAfterSeq = -1,
): SessionAssistantStreamFrame {
  return {
    type: 'start', attemptId, revision: 1,
    startedAfterSeq: startedAfterSeq === -1 ? -1 : SessionSeq(startedAfterSeq),
    turn: 1, step: 1,
  }
}

function chunkFrame(
  index: number,
  attemptId = ATTEMPT,
): SessionAssistantStreamFrame {
  return {
    type: 'chunk', attemptId, revision: index + 2, index, time: 20 + index,
    chunk: { type: 'text-delta', index: 0, text: `chunk-${index}` },
  }
}

function end(
  index: number,
  outcome: Extract<SessionAssistantStreamFrame, { type: 'end' }>['outcome'],
  attemptId = ATTEMPT,
): SessionAssistantStreamFrame {
  return { type: 'end', attemptId, revision: index + 2, index, outcome }
}

function baseline(nextIndex = 1): SessionAssistantStreamBaseline {
  return {
    revision: nextIndex + 1,
    activeAttempt: {
      attemptId: ATTEMPT,
      startedAfterSeq: -1,
      turn: 1,
      step: 1,
      nextIndex,
      stream: [
        { type: 'chunk', time: 20, chunk: { type: 'text-delta', index: 0, text: 'first' } },
        { type: 'chunk', time: 21, chunk: { type: 'text-delta', index: 0, text: 'second' } },
      ],
    },
  }
}

function opened(): ClientAssistantStream {
  const stream = new ClientAssistantStream()
  expect(stream.acceptFrame(start())).toBeUndefined()
  return stream
}

describe('ClientAssistantStream', () => {
  it('replaces the durable window and reconstructs only the baseline prefix', () => {
    const stream = new ClientAssistantStream()
    const durable = ordinary(4)
    const visible = stream.replace([durable], baseline(1))

    expect(visible[0]).toBe(durable)
    expect(visible).toHaveLength(2)
    const reconstructed = visible[1]
    if (reconstructed?.type !== 'transient') throw new Error('expected reconstructed transient chunk')
    expect(reconstructed.event.type).toBe('assistant/live-chunk')
    expect(reconstructed.event.seq).toBe(4.5)
    expect(reconstructed.event.time).toBe(20)

    expect(stream.replace([], baseline(3))).toHaveLength(2)
    expect(stream.replace([])).toEqual([])
  })

  it('passes through durable events not owned by the active attempt', () => {
    const stream = new ClientAssistantStream()
    stream.acceptFrame(start(ATTEMPT, 1))
    for (const durable of [
      ordinary(1),
      messageEvent(2, 1, 1, { op: 'replace', start: 0, end: 0 }),
      attemptEvent(0),
      attemptEvent(3, 2, 1),
      attemptEvent(4, 1, 2),
    ]) {
      expect(stream.acceptDurable(durable)).toEqual({ type: 'publish', entry: durable })
    }
  })

  it('stages one owned settlement and releases it from the matching end frame', () => {
    const stream = opened()
    const durable = messageEvent(2)
    expect(stream.acceptDurable(durable)).toBeUndefined()
    expect(stream.acceptFrame(chunkFrame(0))).toEqual(expect.objectContaining({ type: 'transient' }))
    expect(stream.acceptFrame(end(1, {
      kind: 'committed', eventType: 'assistant/message', seq: 2,
    }))).toEqual({ type: 'settlement', attemptId: String(ATTEMPT), entry: durable })
  })

  it('rebaselines duplicate durable settlements or starts', () => {
    const duplicate = opened()
    const durable = attemptEvent(2)
    expect(duplicate.acceptDurable(durable)).toBeUndefined()
    expect(duplicate.acceptDurable(durable)).toEqual({ type: 'rebaseline' })
    expect(duplicate.acceptFrame(start(LlmAttemptId('session:2')))).toEqual({ type: 'rebaseline' })

    const clean = new ClientAssistantStream()
    expect(clean.acceptFrame(start())).toBeUndefined()
  })

  it('falls back to durable settlement for frames from an unknown attempt', () => {
    const stream = new ClientAssistantStream()
    const unknown = LlmAttemptId('session:unknown')
    expect(stream.acceptFrame(chunkFrame(0, unknown))).toBeUndefined()
    expect(stream.acceptFrame(end(0, { kind: 'abandoned' }, unknown))).toBeUndefined()
    const durable = attemptEvent(2)
    expect(stream.acceptDurable(durable)).toEqual({ type: 'publish', entry: durable })

    const known = opened()
    expect(known.acceptFrame(chunkFrame(0, unknown))).toBeUndefined()
    expect(known.acceptFrame(end(0, { kind: 'abandoned' }, unknown))).toBeUndefined()
  })

  it('rebaselines known attempts on chunk or terminal index mismatch', () => {
    const chunkMismatch = opened()
    expect(chunkMismatch.acceptFrame(chunkFrame(1))).toEqual({ type: 'rebaseline' })

    const endMismatch = opened()
    expect(endMismatch.acceptFrame(end(1, { kind: 'abandoned' }))).toEqual({ type: 'rebaseline' })
  })

  it('settles abandonment only when no durable settlement remains pending', () => {
    const empty = opened()
    expect(empty.acceptFrame(end(0, { kind: 'abandoned' }))).toEqual({
      type: 'abandonment',
      attemptId: String(ATTEMPT),
    })

    const pending = opened()
    expect(pending.acceptDurable(attemptEvent(2))).toBeUndefined()
    expect(pending.acceptFrame(end(0, { kind: 'abandoned' }))).toEqual({ type: 'rebaseline' })
  })

  it('rebaselines committed outcomes without one exact staged settlement', () => {
    const published = new ClientAssistantStream()
    published.replace([attemptEvent(2)], baseline(0))
    expect(published.acceptFrame(end(0, {
      kind: 'committed', eventType: 'assistant/attempt', seq: 2,
    }))).toBeUndefined()

    const missing = opened()
    expect(missing.acceptFrame(end(0, {
      kind: 'committed', eventType: 'assistant/attempt', seq: 2,
    }))).toEqual({ type: 'rebaseline' })

    const wrongType = opened()
    expect(wrongType.acceptDurable(messageEvent(2))).toBeUndefined()
    expect(wrongType.acceptFrame(end(0, {
      kind: 'committed', eventType: 'assistant/attempt', seq: 2,
    }))).toEqual({ type: 'rebaseline' })
  })
})
