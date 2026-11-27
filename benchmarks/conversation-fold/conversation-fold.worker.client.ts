/** Compiled worker for Client history folding, live Assistant text, and tool preparation. */

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNode, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
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
import type { TrajectorySnapshot } from '../../packages/client/ui-trajectory/src/client/trajectory-contract.ts'
import { trajectoryViewDefinition } from '../../packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts'
import { registerTrajectoryToolDefinition } from '../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts'
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

/** Client fold of one PTC run whose root calls fan out into settled subcalls, read through each target. */
export interface PtcDispatchWorkerReport {
  readonly parents: number
  readonly perParent: number
  readonly events: number
  /** Settled subcalls published by the Chat target. */
  readonly children: number
  /** Replace and Chat activation, fastest sample. */
  readonly foldMs: number
  /** Settled subcalls published by the Trajectory target. */
  readonly trajectoryChildren: number
  /** Replace and Trajectory activation of the same window, fastest sample. */
  readonly trajectoryFoldMs: number
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

/** One live Assistant block folded and read through the published Chat snapshot. */
export interface StreamingAssistantWorkerReport {
  readonly blockType: 'text' | 'reasoning'
  readonly pattern: 'ordinary' | 'leading-whitespace'
  readonly characters: number
  readonly fragments: number
  readonly checksum: number
  readonly elapsedMs: number
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
  readonly retainedMb: number
  readonly maxRssMb: number
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
  // The Web composition enables Trajectory by default, and the Assembler folds its Definitions whether or not that target is active.
  registerTrajectoryToolDefinition(ctx)
  events.registerFallback(unknownFallbackDefinition)
  return events
}

class BenchViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition, trajectoryViewDefinition]
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

/** One PTC run that dispatches `perParent` settled subcalls under each root call. */
function synthesizePtcWindow(parents: number, perParent: number): readonly SessionEventLikeEntry[] {
  const entries: SessionEventLikeEntry[] = []
  let seq = 0
  const push = (type: string, data: unknown): void => {
    entries.push(entry(seq, type, data))
    seq += 1
  }
  push('turn/start', { turn: 1 })
  for (let parent = 0; parent < parents; parent += 1) {
    const rootCallId = `call-root-${String(parent)}`
    push('tool/call', { callId: rootCallId, name: 'run_code', arguments: '{}' })
    for (let child = 0; child < perParent; child += 1) {
      const subCallId = `${rootCallId}:ptc:${String(child)}`
      push('tool/ptc-dispatch-start', {
        rootCallId, parentCallId: rootCallId, subCallId, name: 'read', arguments: { file_path: 'src/a.ts' },
      })
      push('tool/ptc-dispatch', {
        rootCallId, parentCallId: rootCallId, subCallId, name: 'read', arguments: { file_path: 'src/a.ts' },
        isError: false, content: [{ type: 'text', text: 'ok' }],
      })
    }
  }
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return entries
}

type PtcTarget = 'chat' | 'trajectory'

/** Root Tool call blocks published by one activated target. */
function publishedPtcRoots(assembler: ConversationNodeAssembler, target: PtcTarget): readonly ToolCallBlock[] {
  if (target === 'chat') {
    const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
    return snapshot === undefined
      ? []
      : [...snapshot.nodes.values()]
        .filter((candidate): candidate is ChatNode<'tool-call'> => candidate.kind === 'tool-call')
        .map(node => node.data.root)
  }
  const snapshot = assembler.snapshot('trajectory') as TrajectorySnapshot | undefined
  return (snapshot?.eventNodes ?? []).filter((node: ConversationNode): node is Extract<ConversationNode, { kind: 'tool-result' }> =>
    node.kind === 'tool-result')
}

/** Fold a PTC run into one target and read every published nested subcall back out of its snapshot. */
function foldPtcTarget(
  entries: readonly SessionEventLikeEntry[],
  target: PtcTarget,
  expected: { readonly parents: number; readonly children: number },
  definitions: ConversationEventRegistry,
): { readonly ms: number; readonly children: number } {
  const started = performance.now()
  const assembler = new ConversationNodeAssembler(definitions, new BenchViewDefinitions())
  assembler.replaceWindow(entries, false)
  assembler.activateTarget(target)
  const roots = publishedPtcRoots(assembler, target)
  const children = roots.reduce((total, root) => total + root.subCalls.length, 0)
  const settled = roots.every(root => root.subCalls.every(child => 'kind' in child && child.kind === 'tool-result'))
  const ms = performance.now() - started
  if (roots.length !== expected.parents || children !== expected.children || !settled) {
    throw new Error(`PTC benchmark published ${String(roots.length)} ${target} roots with ${String(children)} children`)
  }
  return { ms, children }
}

/** Fold a PTC run through the Chat and Trajectory targets and keep each target's fastest sample. */
function foldPtc(
  parents: number,
  perParent: number,
  attempts: number,
  definitions: ConversationEventRegistry,
): PtcDispatchWorkerReport {
  const entries = synthesizePtcWindow(parents, perParent)
  const expected = { parents, children: parents * perParent }
  const best = (target: PtcTarget): { readonly ms: number; readonly children: number } => {
    let fastest = foldPtcTarget(entries, target, expected, definitions)
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      const next = foldPtcTarget(entries, target, expected, definitions)
      if (next.ms < fastest.ms) fastest = next
    }
    return fastest
  }
  const chat = best('chat')
  const trajectory = best('trajectory')
  return {
    parents, perParent, events: entries.length,
    children: chat.children, foldMs: Math.round(chat.ms * 10) / 10,
    trajectoryChildren: trajectory.children, trajectoryFoldMs: Math.round(trajectory.ms * 10) / 10,
  }
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
  const callId = brandString<ToolCallId>('preparing-benchmark')
  const attemptId = brandString<LlmAttemptId>('preparing-benchmark')
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

function streamingAssistant(
  blockType: StreamingAssistantWorkerReport['blockType'],
  pattern: StreamingAssistantWorkerReport['pattern'],
  characters: number,
  fragments: number,
  definitions: ConversationEventRegistry,
): StreamingAssistantWorkerReport {
  if (globalThis.gc === undefined) throw new Error('streaming benchmark requires --expose-gc')
  if (characters % fragments !== 0) throw new Error('streaming characters must divide evenly into fragments')
  const chunkSize = characters / fragments
  const payload = pattern === 'ordinary'
    ? 'abcdefghijklmno '.repeat(Math.ceil(characters / 16)).slice(0, characters)
    : ' '.repeat(characters / 2) + 'abcdefghijklmno '.repeat(Math.ceil(characters / 32)).slice(0, characters / 2)
  const attemptId = brandString<LlmAttemptId>('streaming-benchmark')
  const live = (index: number, chunk: StreamChunk): SessionEventLikeEntry => ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk', seq: 2 + index / (fragments + 1), time: TIME_ZERO + index,
      data: { turn: 1, step: 1, attemptId, chunk },
    },
  })
  const chunks: SessionEventLikeEntry[] = []
  for (let index = 0; index < fragments; index++) {
    chunks.push(live(index + 1, {
      type: blockType === 'text' ? 'text-delta' : 'reasoning-delta', index: 0,
      text: payload.slice(index * chunkSize, (index + 1) * chunkSize),
    }))
  }
  const assembler = new ConversationNodeAssembler(definitions, new BenchViewDefinitions())
  assembler.replaceWindow([
    entry(0, 'turn/start', { turn: 1 }),
    entry(1, 'step/start', { turn: 1, step: 1 }),
    live(0, { type: 'block-start', index: 0, blockType }),
  ], false)
  assembler.activateTarget('chat')
  globalThis.gc()
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  const cpuStart = process.cpuUsage()
  for (const chunk of chunks) assembler.append(chunk)
  assembler.flush()
  const text = streamingText(assembler, blockType)
  // Consuming every character includes any deferred string materialization in the endpoint.
  let checksum = 0
  for (let index = 0; index < text.length; index++) checksum += text.charCodeAt(index)
  const cpu = process.cpuUsage(cpuStart)
  const elapsedMs = performance.now() - start
  if (text !== payload) throw new Error('streaming benchmark did not publish the complete Assistant text')
  globalThis.gc()
  const retainedMb = (process.memoryUsage().heapUsed - before) / 1048576
  // This read keeps the complete owner graph reachable across endpoint collection.
  if (streamingText(assembler, blockType) !== text) throw new Error('streaming benchmark lost its published Assistant text')
  return {
    blockType, pattern, characters: text.length, fragments, checksum,
    elapsedMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    retainedMb, maxRssMb: process.resourceUsage().maxRSS / 1024,
  }
}

function streamingText(assembler: ConversationNodeAssembler, blockType: StreamingAssistantWorkerReport['blockType']): string {
  const node = assembler.get('chat')?.nodes.values().find((candidate): candidate is ChatNode<'assistant-step'> => candidate.kind === 'assistant-step')
  const block = node?.data.blocks[0]
  if (block?.kind !== blockType || (block.kind !== 'text' && block.kind !== 'reasoning')) {
    throw new Error('streaming benchmark did not create its Assistant block')
  }
  return block.text
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
  } else if (process.argv[2] === 'streaming') {
    const blockType = process.argv[3]
    const pattern = process.argv[4]
    if (blockType !== 'text' && blockType !== 'reasoning') throw new Error('streaming block type must be text or reasoning')
    if (pattern !== 'ordinary' && pattern !== 'leading-whitespace') throw new Error('streaming pattern must be ordinary or leading-whitespace')
    const report = streamingAssistant(
      blockType, pattern, positiveInteger(process.argv[5], 'characters'),
      positiveInteger(process.argv[6], 'fragments'), definitions,
    )
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else if (process.argv[2] === 'ptc') {
    const report = foldPtc(
      positiveInteger(process.argv[3], 'parents'),
      positiveInteger(process.argv[4], 'per parent'),
      positiveInteger(process.argv[5], 'attempts'),
      definitions,
    )
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
