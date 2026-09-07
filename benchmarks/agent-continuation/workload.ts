/** Reviewed synthetic tool history shared by continuation and child-catalog measurements. */

import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Workload dimensions, independent of environment and recorded user material. */
export const WORKLOAD = {
  historyTurns: 800,
  toolsPerHistoricalTurn: 4,
  toolResultChars: 2_048,
  requestTurns: 40,
  continuationTurns: 20,
  profileTurns: 100,
  toolsPerLiveTurn: 8,
  children: 16,
  childHistoryTurns: 80,
} as const

/** Fixed clock used only to author persisted synthetic input. */
export const TIME_ZERO = 1_700_000_000_000
/** Durable parent identity of the measured continuation. */
export const PARENT_ID = SessionId('bench-parent')

/**
 * Construct a deterministic model reply without retaining past requests.
 * @param serial - unique response ordinal.
 * @param tools - number of synthetic tool calls, or zero for a final text reply.
 * @returns streamed chunks and their known final blocks.
 */
export function response(serial: number, tools: number): { chunks: StreamChunk[]; content: ContentBlock[] } {
  const content: ContentBlock[] = [
    { type: 'reasoning', text: 'Inspect the synthetic result. '.repeat(8) },
    { type: 'text', text: 'Synthetic response. '.repeat(8) },
    ...Array.from({ length: tools }, (_, index): ContentBlock => ({
      type: 'tool-call', id: ToolCallId('call-' + String(serial) + '-' + String(index)), name: 'bench_tool',
      arguments: JSON.stringify({ ordinal: serial * 100 + index }),
    })),
  ]
  const chunks: StreamChunk[] = []
  content.forEach((block, index) => {
    chunks.push({ type: 'block-start', index, blockType: block.type })
    if (block.type === 'text' || block.type === 'reasoning') {
      for (let offset = 0; offset < block.text.length; offset += 16) {
        chunks.push({ type: block.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text.slice(offset, offset + 16) })
      }
    } else if (block.type === 'tool-call') {
      for (let offset = 0; offset < block.arguments.length; offset += 8) {
        chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments.slice(offset, offset + 8) })
      }
    }
    chunks.push({ type: 'block-end', index, block })
  })
  chunks.push({ type: 'usage', usage: { inputTokens: 10_000, outputTokens: 100 } })
  chunks.push({ type: 'finish', reason: { kind: tools === 0 ? 'stop' : 'tool-calls' } })
  return { chunks, content }
}

/**
 * Author completed two-step turns through production Session append and stream compaction.
 * @param turns - completed historical turns.
 * @returns detached current-generation events with fixed ids, timestamps and payloads.
 */
export function syntheticHistory(turns: number): SessionEvent[] {
  const session = Session.create(PARENT_ID)
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: MessageId('prompt-' + String(turn)), role: 'user',
      content: [{ type: 'text', text: 'Inspect synthetic module ' + String(turn) }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    for (const step of [1, 2]) {
      if (step === 2) session.append('step/start', { turn, step })
      const reply = response(turn * 2 + step, step === 1 ? WORKLOAD.toolsPerHistoricalTurn : 0)
      const stream = new AssistantStreamAccumulator()
      reply.chunks.forEach((chunk, index) => { stream.push({ time: TIME_ZERO + turn * 1_000 + step * 100 + index, chunk }) })
      session.append('assistant/message', {
        turn, step,
        message: { id: MessageId('reply-' + String(turn) + '-' + String(step)), role: 'assistant', content: reply.content, source: { kind: 'model', provider: 'bench', model: 'bench' } },
        stream: [...stream.snapshot()],
      }, { surfaceOp: 'append' })
      for (const block of reply.content) {
        if (block.type !== 'tool-call') continue
        const call = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
        session.append('tool/result', {
          turn, step,
          message: {
            id: MessageId('result-' + block.id), role: 'user', source: { kind: 'tool', callId: block.id },
            content: [{ type: 'tool-result', toolCallId: block.id, content: [{ type: 'text', text: resultText(turn) }], isError: false }],
          },
        }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      }
      session.append('step/end', { turn, step })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents().map(event => ({ ...event, time: TIME_ZERO + event.seq }))
}

/**
 * Build a bounded synthetic file-read result with a varying prefix.
 * @param ordinal - deterministic result identifier.
 * @returns exactly the reviewed number of UTF-16 characters.
 */
export function resultText(ordinal: number): string {
  return ('module ' + String(ordinal) + '\n' + 'export const synthetic = 42;\n'.repeat(100)).slice(0, WORKLOAD.toolResultChars)
}
