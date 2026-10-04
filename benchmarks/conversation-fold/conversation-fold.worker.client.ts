/** Compiled worker for Client history folding and live tool preparation. */

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
// These Client-only fold modules have no plain-Node package export and are compiled into this worker.
import { ConversationNodeAssembler } from '../../packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { ConversationEventRegistry } from '../../packages/client/ui-conversation/src/client/conversation/event-registry.ts'
import { inspectRequestPrompt } from '../../packages/client/ui-conversation/src/client/contract/request-inspection.ts'
import type { ConversationViewDefinition } from '../../packages/client/ui-conversation/src/client/contract/conversation.ts'
import { registerAssistantConversationNode } from '../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/message.ts'
import { processGroupDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts'
import { requestPromptDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts'
import { retryDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/retry.ts'
import { registerToolConversationNode } from '../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts'
import { registerTurnProcess } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import { registerTurnTailConversationNode } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts'
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

/** Incremental argument folding through the Tool Definition and Chat group publication. */
export interface PreparingToolWorkerReport {
  readonly tool: 'write' | 'bash'
  readonly characters: number | undefined
  readonly fragments: number
  readonly elapsedMs: number
  readonly retainedMb: number
  readonly maxRssMb: number
  readonly rowReads: number
  readonly progressKb: number | undefined
  readonly filePath: string | undefined
  readonly detail: string | undefined
}

function registerEventDefinitions(ctx: Context): ConversationEventRegistry {
  const events = new ConversationEventRegistry(ctx)
  // Only the service holder is an adapter; registrations and routing use production code.
  Object.defineProperty(ctx, 'uiConversation', { value: { events } })
  events.register(nextStepInboxDefinition)
  events.register(messageDefinition)
  events.register(requestPromptDefinition(inspectRequestPrompt))
  registerAssistantConversationNode(ctx)
  registerTurnProcess(ctx)
  registerToolConversationNode(ctx)
  events.register(commandDefinition)
  events.register(compactionDefinition)
  events.register(retryDefinition)
  events.register(turnErrorDefinition)
  events.register(turnMaxTokensDefinition)
  registerTurnTailConversationNode(ctx)
  events.registerFallback(unknownFallbackDefinition)
  return events
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

function foldOnce(entries: readonly SessionEventLikeEntry[], definitions: ConversationEventRegistry): { readonly ms: number; readonly nodes: number } {
  const started = performance.now()
  const assembler = new ConversationNodeAssembler(definitions, new BenchViewDefinitions())
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
  return { ms: performance.now() - started, nodes: snapshot?.order.length ?? 0 }
}

function bestOf(
  entries: readonly SessionEventLikeEntry[],
  attempts: number,
  definitions: ConversationEventRegistry,
): { readonly ms: number; readonly nodes: number } {
  let best = foldOnce(entries, definitions)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const next = foldOnce(entries, definitions)
    if (next.ms < best.ms) best = next
  }
  return best
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function preparingTool(tool: 'write' | 'bash', characters: number, definitions: ConversationEventRegistry): PreparingToolWorkerReport {
  if (globalThis.gc === undefined) throw new Error('preparing benchmark requires --expose-gc')
  const chunkSize = 16
  const chunksPerPublication = 64
  const payload = 'abcdefghijklmno '.repeat(Math.ceil(characters / chunkSize)).slice(0, characters)
  const tail = `${payload}"}`
  const callId = ToolCallId('preparing-benchmark')
  const attemptId = LlmAttemptId('preparing-benchmark')
  const delta = (index: number, argumentsDelta: string): SessionEventLikeEntry => ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk', seq: 2 + index / (tail.length + 1), time: TIME_ZERO + index,
      data: { turn: 1, step: 1, attemptId, chunk: {
        type: 'tool-call-delta', index: 0, id: callId, argumentsDelta,
        ...index === 0 ? { name: tool } : {},
      } },
    },
  })
  const chunks: SessionEventLikeEntry[] = []
  for (let at = 0; at < tail.length; at += chunkSize) chunks.push(delta(at + 1, tail.slice(at, at + chunkSize)))
  const assembler = new ConversationNodeAssembler(
    definitions, new BenchViewDefinitions(),
    { entries: () => [processGroupDefinition], forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  assembler.replaceWindow([
    entry(0, 'turn/start', { turn: 1 }),
    entry(1, 'step/start', { turn: 1, step: 1 }),
    delta(0, tool === 'write' ? '{"file_path":"preview.md","content":"' : '{"command":"'),
  ], false)
  assembler.activateTarget('chat')
  const snapshot = assembler.get('chat')
  const node = snapshot?.nodes.values().find((candidate): candidate is ChatNode<'tool-call'> => candidate.kind === 'tool-call')
  if (snapshot === undefined || node === undefined) throw new Error('preparing benchmark did not create its Tool node')
  const args = node.data.root.args
  const source = snapshot.nodes.source(node.key)
  let rowReads = 0
  let progressKb: number | undefined
  let filePath: string | undefined
  const readRow = (): void => {
    const current = source.getSnapshot()
    if (current?.kind !== 'tool-call') throw new Error('preparing benchmark lost its Tool node')
    const currentArgs = (current as ChatNode<'tool-call'>).data.root.args
    if (tool === 'write') {
      const length = currentArgs.stringLength('content', { step: 1024 })
      progressKb = length === undefined ? undefined : Math.ceil(length / 1024)
      filePath = currentArgs.text('file_path')
    }
    rowReads++
  }
  readRow()
  const unsubscribe = tool === 'write' ? source.subscribe(readRow) : () => {}
  globalThis.gc()
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  for (let index = 0; index < chunks.length; index++) {
    assembler.append(chunks[index]!)
    if ((index + 1) % chunksPerPublication === 0) assembler.flush()
  }
  assembler.flush()
  const elapsedMs = performance.now() - start
  unsubscribe()
  globalThis.gc()
  const retainedMb = (process.memoryUsage().heapUsed - before) / 1048576
  const groups = assembler.grouped('chat')
  const group = groups?.entries.find(reference => reference.kind === 'group')
  return {
    tool, characters: args.stringLength(tool === 'write' ? 'content' : 'command'), fragments: chunks.length,
    elapsedMs, retainedMb, maxRssMb: process.resourceUsage().maxRSS / 1024,
    rowReads, progressKb, filePath,
    detail: group === undefined ? undefined : groups?.groupSource(group.key).getSnapshot()?.data.summary.runningDetail,
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-brand': import.meta.resolve('@deepseek-ai/dsh-brand'),
  '@deepseek-ai/dsh-client-store': import.meta.resolve('@deepseek-ai/dsh-client-store'),
  '@deepseek-ai/dsh-llm/assistant-stream': import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'),
  '@deepseek-ai/dsh-session/surface': import.meta.resolve('@deepseek-ai/dsh-session/surface'),
  '@deepseek-ai/dsh-token-meter/client': import.meta.resolve('@deepseek-ai/dsh-token-meter/client'),
  '@deepseek-ai/dsh-util-values': import.meta.resolve('@deepseek-ai/dsh-util-values'),
})
const scope = new Context()
try {
  const definitions = registerEventDefinitions(scope)
  if (process.argv[2] === 'preparing') {
    const tool = process.argv[3]
    if (tool !== 'write' && tool !== 'bash') throw new Error('preparing benchmark tool must be write or bash')
    const report = preparingTool(tool, positiveInteger(process.argv[4], 'characters'), definitions)
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
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
    const smallFold = bestOf(small.entries, attempts, definitions)
    const largeFold = bestOf(large.entries, attempts, definitions)
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
  }
} finally {
  await scope.fiber.dispose()
}
