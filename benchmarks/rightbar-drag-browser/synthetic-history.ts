/** Synthetic current-generation history whose rows wrap, for measuring transcript restyles during a resize. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, type SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

/** Closed turns in the workload; every one is loaded before the drag. */
export const HISTORY_TURNS = 120
/** Identity private to each isolated scaffold. */
export const SESSION_ID = 'benchmark-rightbar-drag'
const TITLE = 'SYNTHETIC_RIGHTBAR_DRAG'

function prose(turn: number): string {
  const paragraph = `Turn ${String(turn)} synthetic analysis: the renderer measures every row, wraps mixed text 混合中文段落用于换行测量, and keeps \`inline code\` beside **bold** words. `
  const parts = [paragraph.repeat(6), paragraph.repeat(4)]
  parts.push(Array.from({ length: 6 }, (_, i) => `- item ${String(i)}: ${paragraph.slice(0, 120)}`).join('\n'))
  if (turn % 10 === 0) {
    parts.push('```ts\n' + Array.from({ length: 40 }, (_, i) => `const value${String(i)} = compute(${String(i)}, "${'x'.repeat(30)}")`).join('\n') + '\n```')
  }
  if (turn % 15 === 0) {
    parts.push('| a | b | c |\n|---|---|---|\n' + Array.from({ length: 8 }, (_, i) => `| ${String(i)} | ${paragraph.slice(0, 60)} | ${String(i * 3)} |`).join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * Create prose, lists, code, tables, reasoning, and tool output without reading user data.
 * @returns Current Session JSONL accepted by the shared Web seeder.
 */
export function syntheticHistory(): string {
  const session = Session.create(brandString<SessionId>(SESSION_ID))
  for (let turn = 1; turn <= HISTORY_TURNS; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Question ${String(turn)}: ` + '请检查宽度变化时的排版。 '.repeat(12) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    const tool = turn % 5 === 0
    const callId = brandString<ToolCallId>(`synthetic-call-${String(turn)}`)
    const args = '{"path":"src/a.ts"}'
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: 'Compare the synthetic module and test. '.repeat(20) },
          { type: 'text', text: prose(turn) },
          ...tool ? [{ type: 'tool-call' as const, id: callId, name: 'synthetic_tool', arguments: args }] : [],
        ],
      }),
      usage: { inputTokens: 4000, outputTokens: 800 },
    }, { surfaceOp: 'append' })
    if (tool) {
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_tool', arguments: args })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'Synthetic tool output line.\n'.repeat(40) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }
  return [JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}
