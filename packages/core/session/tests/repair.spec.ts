import { describe, expect, it } from 'vitest'
import { ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers as repairInterruptedTurn, SessionSeq, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '../src/index.ts'
import type { SessionEvent as LogicalSessionEvent, SurfaceEvent } from '../src/index.ts'

interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  [key: string]: unknown
}

function interruptedTurnClosers(events: readonly SessionEvent[]): LogicalSessionEvent[] {
  for (const event of events) SessionSeq(event.seq)
  return repairInterruptedTurn(events as unknown as readonly LogicalSessionEvent[])
}

/**
 * Unit coverage for the crash-recovery closer synthesis. The persistence
 * contract exercises it end-to-end through the real JSONL provider; these tests pin the
 * pure function's branches directly — especially the synthetic error
 * `tool/result` for a tool call the crash left unanswered (without it a
 * resumed session replays a dangling assistant tool-call and the provider
 * rejects the transcript).
 */

const userTurnStart = (turn: number, seq: number): SessionEvent =>
  ({ type: 'turn/start', seq, time: seq, data: { turn } })

describe('interruptedTurnClosers', () => {
  it('returns nothing for a balanced log (ends on turn/end)', () => {
    const balanced: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(interruptedTurnClosers(balanced)).toEqual([])
  })

  it('returns nothing for an empty log', () => {
    expect(interruptedTurnClosers([])).toEqual([])
  })

  it('closes an open turn with no open step (turn/end {interrupted} only)', () => {
    const events: SessionEvent[] = [userTurnStart(1, 0)]
    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['turn/end'])
    const end = closers[0]!
    expect(end.seq).toBe(1)
    expect(end.type === 'turn/end' && end.data.reason).toEqual({ kind: 'interrupted' })
  })

  it('closes an open step before the turn (step/end then turn/end)', () => {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    ]
    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['step/end', 'turn/end'])
    expect(closers.map(e => e.seq)).toEqual([2, 3])
  })

  it('marks an assistant tool request with no recorded call as not started', () => {
    const events: SessionEvent[] = [
      userTurnStart(2, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling a tool' },
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
    ]
    const closers = interruptedTurnClosers(events)
    // tool/result (for the orphaned call) → step/end → turn/end, contiguous seqs.
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(closers.map(e => e.seq)).toEqual([3, 4, 5])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data).toMatchObject({
      turn: 2,
      step: 1,
      message: {
        source: { callId: ToolCallId('call-1') },
        content: [{ isError: true }],
      },
      error: { code: TOOL_NOT_STARTED },
    })
    expect(result.type === 'tool/result' && result.data.message.content[0].content).toEqual([{
      type: 'text', text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
    }])
  })

  it('does NOT synthesize a result for a tool-call that already has one', () => {
    const events: SessionEvent[] = [
      userTurnStart(2, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'tool/result', seq: 3, time: 3, data: {
        turn: 2, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-1'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      } },
    ]
    // The call is answered, so only the open step + turn need closing.
    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['step/end', 'turn/end'])
  })

  it('does NOT synthesize a result after the owning step already closed', () => {
    const events: SessionEvent[] = [
      userTurnStart(2, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'step/end', seq: 3, time: 3, data: { turn: 2, step: 1 } },
    ]

    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['turn/end'])
    expect(closers[0]?.seq).toBe(4)
  })

  it('synthesizes results only for the still-open turn, not a committed earlier turn', () => {
    // Turn 1 completed with its own tool call+result (balanced). Turn 2 crashed
    // with an unanswered call. Only turn 2's call must get a synthetic result.
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('old-call'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'tool/result', seq: 3, time: 3, data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('old-call'),
          content: [],
          isError: false,
        }),
      } },
      { type: 'step/end', seq: 4, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      userTurnStart(2, 6),
      { type: 'step/start', seq: 7, time: 7, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 8, time: 8, data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('new-call'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
    ]
    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data.message.source.callId).toBe('new-call')
  })

  it('synthesizes a result for each of multiple unanswered calls, in log order', () => {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-a'), name: 'bash', arguments: '{}' },
            { type: 'tool-call', id: ToolCallId('call-b'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      // call-a got answered before the crash; call-b did not.
      { type: 'tool/result', seq: 3, time: 3, data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-a'),
          content: [],
          isError: false,
        }),
      } },
    ]
    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data.message.source.callId).toBe('call-b')
  })

  it('synthesized tool/result carries surfaceOp and sourceEventSeqs when tool/call was logged', () => {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' } },
    ]
    const closers = interruptedTurnClosers(events)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect((result as SurfaceEvent).surfaceOp).toBe('append')
    expect((result as SurfaceEvent).sourceEventSeqs).toEqual([3])
    expect(result.type === 'tool/result' && result.data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })
    if (result.type !== 'tool/result' || result.data.message.content[0].content[0]?.type !== 'text') {
      throw new Error('expected a text tool result')
    }
    expect(result.data.message.content[0].content[0].text).toContain('retry only if the operation is read-only or idempotent')
    expect(result.data.message.content[0].content[0].text).toContain('first verify external state or ask the user')
  })

  it('handles tool/call without a matching assistant/message entry gracefully', () => {
    // A raw tool/call with no assistant-registered pending call has nothing to
    // answer; repair still closes the step and turn without synthesizing a result.
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: ToolCallId('orphan'), name: 'bash', arguments: '{}' } },
    ]
    const closers = interruptedTurnClosers(events)
    // No pending calls → no synthetic tool/result, just step/end + turn/end.
    expect(closers.map(e => e.type)).toEqual(['step/end', 'turn/end'])
  })
})
