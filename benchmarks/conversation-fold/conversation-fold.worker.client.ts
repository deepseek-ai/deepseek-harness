/** Compiled worker for the cold Client conversation-fold benchmark. */

import { performance } from 'node:perf_hooks'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
// These Client-only fold modules have no plain-Node package export and are compiled into this worker.
import { ConversationNodeAssembler } from '../../packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { inspectRequestPrompt } from '../../packages/client/ui-conversation/src/client/contract/request-inspection.ts'
import type {
  ConversationNodeDefinition,
  ConversationViewDefinition,
} from '../../packages/client/ui-conversation/src/client/contract/conversation.ts'
import { assistantDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/message.ts'
import { requestPromptDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts'
import { retryDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/retry.ts'
import { toolDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts'
import { turnProcessDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

const TIME_ZERO = 1_700_000_000_000

/** Result emitted by the compiled conversation-fold worker. */
export interface ConversationFoldWorkerReport {
  readonly events: number
  readonly compactRecords: number
  readonly streamedDeltas: number
  readonly chatNodes: number
  readonly smallFoldMs: number
  readonly largeFoldMs: number
  readonly scaling: number
}

class BenchEventDefinitions {
  readonly definitions: readonly ConversationNodeDefinition[] = [
    nextStepInboxDefinition,
    messageDefinition,
    requestPromptDefinition(inspectRequestPrompt),
    assistantDefinition,
    turnProcessDefinition,
    toolDefinition,
    commandDefinition,
    compactionDefinition,
    retryDefinition,
    turnErrorDefinition,
    turnMaxTokensDefinition,
    turnTailDefinition,
  ]

  entries(): readonly ConversationNodeDefinition[] {
    return this.definitions
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class BenchViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function entry(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { seq, time: TIME_ZERO + seq, type, data, ...extra } as unknown as SessionEvent,
  }
}

function synthesizeWindow(
  turns: number,
  deltas: number,
): { readonly entries: readonly SessionEventLikeEntry[]; readonly records: number } {
  const entries: SessionEventLikeEntry[] = []
  let seq = 0
  let records = 0
  const push = (type: string, data: unknown, extra: Record<string, unknown> = {}): void => {
    entries.push(entry(seq, type, data, extra))
    seq += 1
  }
  const reasoningDeltas = Math.floor(deltas / 4)
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    push('user/message', {
      id: `user-${String(turn)}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    push('step/start', { turn, step: 1 })
    const accumulator = new AssistantStreamAccumulator()
    let time = TIME_ZERO + seq * 1_000
    const stream = (chunk: StreamChunk): void => {
      accumulator.push({ time, chunk })
      time += 1
    }
    stream({ type: 'block-start', index: 0, blockType: 'reasoning' })
    let reasoning = ''
    for (let index = 0; index < reasoningDeltas; index += 1) {
      const delta = `r${String(index)} `
      reasoning += delta
      stream({ type: 'reasoning-delta', index: 0, text: delta })
    }
    stream({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    stream({ type: 'block-start', index: 1, blockType: 'text' })
    let text = ''
    for (let index = 0; index < deltas; index += 1) {
      const delta = `w${String(index)} `
      text += delta
      stream({ type: 'text-delta', index: 1, text: delta })
    }
    stream({ type: 'block-end', index: 1, block: { type: 'text', text } })
    const usage = { inputTokens: 100, outputTokens: deltas }
    stream({ type: 'usage', usage })
    stream({ type: 'finish', reason: { kind: 'stop' } })
    const snapshot = accumulator.snapshot()
    records += snapshot.length
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${String(turn)}`,
        role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage,
      stream: snapshot,
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { entries, records }
}

function foldOnce(entries: readonly SessionEventLikeEntry[]): { readonly ms: number; readonly nodes: number } {
  const started = performance.now()
  const assembler = new ConversationNodeAssembler(new BenchEventDefinitions(), new BenchViewDefinitions())
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
  return { ms: performance.now() - started, nodes: snapshot?.order.length ?? 0 }
}

function bestOf(
  entries: readonly SessionEventLikeEntry[],
  attempts: number,
): { readonly ms: number; readonly nodes: number } {
  let best = foldOnce(entries)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const next = foldOnce(entries)
    if (next.ms < best.ms) best = next
  }
  return best
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-client-store': import.meta.resolve('@deepseek-ai/dsh-client-store'),
  '@deepseek-ai/dsh-llm/assistant-stream': import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'),
  '@deepseek-ai/dsh-session/surface': import.meta.resolve('@deepseek-ai/dsh-session/surface'),
  '@deepseek-ai/dsh-token-meter/client': import.meta.resolve('@deepseek-ai/dsh-token-meter/client'),
})
const [turnsValue, smallDeltasValue, largeDeltasValue, attemptsValue] = process.argv.slice(2)
const turns = positiveInteger(turnsValue, 'turns')
const smallDeltas = positiveInteger(smallDeltasValue, 'small deltas')
const largeDeltas = positiveInteger(largeDeltasValue, 'large deltas')
const attempts = positiveInteger(attemptsValue, 'attempts')
const small = synthesizeWindow(turns, smallDeltas)
const large = synthesizeWindow(turns, largeDeltas)
if (large.entries.length !== small.entries.length || large.records !== small.records) {
  throw new Error('conversation-fold workloads must have matching event and compact-record counts')
}
const smallFold = bestOf(small.entries, attempts)
const largeFold = bestOf(large.entries, attempts)
const report: ConversationFoldWorkerReport = {
  events: large.entries.length,
  compactRecords: large.records,
  streamedDeltas: turns * (largeDeltas + Math.floor(largeDeltas / 4)),
  chatNodes: largeFold.nodes,
  smallFoldMs: Math.round(smallFold.ms * 10) / 10,
  largeFoldMs: Math.round(largeFold.ms * 10) / 10,
  scaling: Math.round((largeFold.ms / Math.max(smallFold.ms, 1)) * 100) / 100,
}
process.stdout.write(`${JSON.stringify(report)}\n`)
