import {
  ToolCallId, createMessage, createToolResultMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
// Minimal SessionEvent builders for orchestration tests (shape mirrors what the
// host emits; only the fields the object layer reads).
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  SessionEventEntry,
  SessionPage,
  SessionWireEvent,
} from '../src/types.ts'

/** One text content block (local helper). */
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }]

const at = (seq: SessionSeq, e: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, ...e }) as unknown as SessionEvent

export const ev = {
  turnStart: (seq: SessionSeq, turn: number): SessionEvent =>
    at(seq, { type: 'turn/start', data: { turn } }),
  user: (seq: SessionSeq, body: string): SessionEvent =>
    at(seq, { type: 'user/message', surfaceOp: 'append', data: createUserMessage({
      content: text(body), source: { kind: 'user' },
    }) }),
  stepStart: (seq: SessionSeq, turn: number, step = 0): SessionEvent =>
    at(seq, { type: 'step/start', data: { turn, step } }),
  chunkStart: (seq: SessionSeq, turn: number, step = 0, index = 0): SessionEvent =>
    at(seq, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'block-start', index, blockType: 'text' } } }),
  chunkText: (seq: SessionSeq, turn: number, piece: string, step = 0, index = 0): SessionEvent =>
    at(seq, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', index, text: piece } } }),
  assistant: (seq: SessionSeq, turn: number, body: string, step = 0): SessionEvent =>
    at(seq, { type: 'assistant/message', surfaceOp: 'append', data: {
      turn, step,
      message: createMessage({
        role: 'assistant',
        content: text(body),
        source: {
          kind: 'model',
          ...{ provider: 'fake', model: 'fk-1' },
        },
      }),
    } }),
  toolCall: (seq: SessionSeq, turn: number, callId: string, name: string, args: string, step = 0): SessionEvent =>
    at(seq, { type: 'tool/call', data: { turn, step, callId, name, arguments: args } }),
  toolResult: (seq: SessionSeq, turn: number, callId: string, body: string, step = 0): SessionEvent =>
    at(seq, {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn,
        step,
        message: createToolResultMessage({
          callId: ToolCallId(callId),
          content: text(body),
          isError: false,
        }),
      },
    }),
  codeDispatchStart: (seq: SessionSeq, parentCallId: string, n: number, name: string, args: unknown): SessionEvent =>
    at(seq, {
      type: 'tool/code-dispatch-start',
      data: { rootCallId: parentCallId, parentCallId, subCallId: `${parentCallId}:code:${n}`, name, arguments: args },
    }),
  codeDispatch: (
    seq: SessionSeq,
    parentCallId: string,
    n: number,
    name: string,
    args: unknown,
    body: string,
    isError = false,
  ): SessionEvent =>
    at(seq, {
      type: 'tool/code-dispatch',
      data: { rootCallId: parentCallId, parentCallId, subCallId: `${parentCallId}:code:${n}`, name, arguments: args, isError, content: text(body) },
    }),
  stepEnd: (seq: SessionSeq, turn: number, step = 0): SessionEvent =>
    at(seq, { type: 'step/end', data: { turn, step } }),
  retry: (
    seq: SessionSeq,
    turn: number,
    step = 0,
    retry = 1,
    maxRetries = 2,
    delayMs = 500,
    message = 'temporary transport failure',
  ): SessionEvent =>
    at(seq, {
      type: 'llm/retry',
      data: {
        turn, step,
        provider: 'fake', mode: 'normal', policyKey: 'fake-normal',
        retry, maxRetries, delayMs,
        failure: { code: 'TRANSPORT', message },
      },
    }),
  turnEnd: (seq: SessionSeq, turn: number, reason: 'completed' | 'aborted' | 'disposed' = 'completed'): SessionEvent =>
    at(seq, { type: 'turn/end', data: {
      turn,
      reason: reason === 'completed'
        ? { kind: 'completed' }
        : { kind: 'aborted', reason: { kind: reason === 'disposed' ? 'disposed' : 'user' } },
    } }),
  commandRun: (seq: SessionSeq, commandId: string, name: string, args = ''): SessionEvent =>
    at(seq, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } }),
  commandRunWithoutInput: (seq: SessionSeq, commandId: string, name: string): SessionEvent =>
    at(seq, { type: 'command/run', data: { commandId, name, source: { kind: 'user' } } }),
  commandDone: (
    seq: SessionSeq,
    commandId: string,
    kind: 'success' | 'error' = 'success',
    text?: string,
    sourceEventSeq?: SessionSeq,
  ): SessionEvent =>
    at(seq, { type: 'command/done', data: {
      commandId,
      kind,
      ...text === undefined ? {} : { text },
      ...sourceEventSeq === undefined ? {} : { sourceEventSeq },
    } }),
  /** A compaction's log-only `compaction/summary` record. */
  compactSummary: (seq: SessionSeq, summary: string, start: SessionSeq, end: SessionSeq): SessionEvent =>
    at(seq, { type: 'compaction/summary', data: {
      summary: text(summary),
      shadowedRange: { start, end },
      shadowedSeqs: [start, end],
      shadowedTokenCount: 100,
      provider: 'fake',
      model: 'compact-1',
    } }),
  /** The replacement user message a compaction backend lands (the checkpoint). */
  compactCheckpoint: (
    seq: SessionSeq,
    summarySeq: SessionSeq,
    start: SessionSeq,
    end: SessionSeq,
  ): SessionEvent =>
    at(seq, {
      type: 'user/message',
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [summarySeq, start, end],
      data: createUserMessage({
        content: text('<context_checkpoint>model only</context_checkpoint>'),
        source: { kind: 'plugin', plugin: 'compact' },
      }),
    }),
}

/** One complete plain turn (turn/start → user → step → assistant → turn/end), 6 events from startSeq. */
export function plainTurn(startSeq: SessionSeq, turn: number, ask: string, answer: string): SessionEvent[] {
  return [
    ev.turnStart(startSeq, turn),
    ev.user(SessionSeq(startSeq + 1), ask),
    ev.stepStart(SessionSeq(startSeq + 2), turn),
    ev.assistant(SessionSeq(startSeq + 3), turn, answer),
    ev.stepEnd(SessionSeq(startSeq + 4), turn),
    ev.turnEnd(SessionSeq(startSeq + 5), turn),
  ]
}

/** Wrap raw events in the journal envelope returned by history. */
export function entries(events: readonly SessionEvent[]): SessionEventEntry[] {
  return events.map(event => ({ type: 'event', event: event as unknown as SessionWireEvent }))
}

/** Build one view-less history response value. */
export function historyValue(events: readonly SessionEvent[], hasMore = false): SessionPage {
  return {
    records: entries(events),
    hasMore,
  }
}
