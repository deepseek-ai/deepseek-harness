import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-tools/types'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { AssistantChatData, ChatNode, FinalAssistantChatData } from '../contract/chat-nodes.ts'
import {
  isSubagentDelegationTool, sameTurnProcessSpec, type TurnProcessSpec,
} from '../contract/turn-process.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'
import { toAssistantBlocks } from './event-projection.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Turn-level disclosure controlling process rows before the finalized answer. */
    'turn-process': import('../contract/chat-nodes.ts').TurnProcessChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Process range and finalized answer boundary for this Turn. */
    'turn-process': TurnProcessSpec
  }
}

interface TurnProcessState {
  readonly turn: number
  readonly assistantStartByStep: ReadonlyMap<number, number>
  readonly messageCountByStep: ReadonlyMap<number, number>
  readonly otherStartSeq?: number
  readonly controlAnchorSeq?: number
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

function eventTurn(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

function visibleChunk(chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text.trim() !== ''
  if (chunk.type === 'block-start') {
    return chunk.blockType !== 'text'
        && chunk.blockType !== 'reasoning'
        && chunk.blockType !== 'tool-call'
  }
  if (chunk.type !== 'block-end') return false
  const block = chunk.block
  if (block.type === 'tool-call') return false
  if (block.type === 'text' || block.type === 'reasoning') return block.text.trim() !== ''
  return true
}

function visibleAssistantEvent(event: ConversationEvent): boolean {
  if (event.type === 'assistant/live-chunk') return visibleChunk(event.data.chunk)
  if (event.type === 'assistant/attempt') {
    return expandAssistantStream(event.data.stream).some(member => visibleChunk(member.chunk))
  }
  return event.type === 'assistant/message'
    && isAppendSurfaceEvent(event)
    && toAssistantBlocks(event.data.message.content).some((block) => {
      if (block.kind === 'tool-call') return false
      if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
      return true
    })
}

type ProcessEvidence =
  | { readonly kind: 'assistant'; readonly seq: number; readonly step: number }
  | { readonly kind: 'other'; readonly seq: number }

function processEvidence(event: ConversationEvent): ProcessEvidence | undefined {
  if (visibleAssistantEvent(event)) {
    if (event.type !== 'assistant/live-chunk'
      && event.type !== 'assistant/message'
      && event.type !== 'assistant/attempt') return undefined
    return { kind: 'assistant', seq: event.seq, step: event.data.step }
  }
  if (event.type === 'tool/call'
    || (event.type === 'tool/result' && isAppendSurfaceEvent(event))
    || event.type === 'llm/retry') return { kind: 'other', seq: event.seq }
  return undefined
}

function turnLocation(context: ConversationNodeContext<TurnProcessState>): TurnLocation | undefined {
  const location: ConversationLocation | undefined = context.start?.location ?? context.matches.at(-1)?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
}

function fallbackState(context: ConversationNodeContext<TurnProcessState>): TurnProcessState | undefined {
  const turn = context.matches.map(match => eventTurn(match.event)).find(candidate => candidate !== undefined)
  if (turn === undefined) return undefined
  let state: TurnProcessState = {
    turn,
    assistantStartByStep: new Map(),
    messageCountByStep: new Map(),
    messageCount: 0,
    toolCallCount: 0,
    subagentCount: 0,
  }
  for (const match of context.matches) state = updateProcessState(state, match.event)
  return state
}

function isFinalAssistant(
  data: Readonly<AssistantChatData> | undefined,
): data is Readonly<FinalAssistantChatData> {
  return data?.finalNode !== undefined
}

function latestAnswer(turn: TurnLocation): Readonly<FinalAssistantChatData> | null {
  const latestStep = turn.steps.at(-1)
  const data: Readonly<AssistantChatData> | undefined = latestStep?.data.get('assistant-step')
  if (!isFinalAssistant(data) || !hasAssistantReplyContent(data.blocks)) return null
  return data.blocks.some(block => block.kind === 'tool-call') ? null : data
}

function processSpec(state: TurnProcessState, turn: TurnLocation): TurnProcessSpec | null {
  const controlAnchorSeq = state.controlAnchorSeq
  if (controlAnchorSeq === undefined) return null
  const answer = latestAnswer(turn)
  const counts = {
    messageCount: answer === null
      ? state.messageCount
      : [...state.messageCountByStep]
        .filter(([step]) => step < answer.step)
        .reduce((total, [, count]) => total + count, 0),
    toolCallCount: state.toolCallCount,
    subagentCount: state.subagentCount,
  }
  if (answer === null) {
    return {
      turn: turn.turn,
      controlAnchorSeq,
      processStartSeq: controlAnchorSeq,
      answerAnchorSeq: null,
      answerStep: null,
      inlineReasoning: false,
      ...counts,
    }
  }
  const inlineReasoning = answer.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
  const earlierAssistantSeq = Math.min(
    ...[...state.assistantStartByStep]
      .filter(([step]) => step < answer.step)
      .map(([, seq]) => seq),
  )
  const externalProcessSeq = Math.min(
    state.otherStartSeq ?? Number.POSITIVE_INFINITY,
    earlierAssistantSeq,
  )
  return {
    turn: turn.turn,
    controlAnchorSeq,
    processStartSeq: turn.start?.seq
      ?? (Number.isFinite(externalProcessSeq) ? externalProcessSeq : answer.finalNode.seq),
    answerAnchorSeq: answer.finalNode.seq,
    answerStep: answer.step,
    inlineReasoning,
    ...counts,
  }
}

function updateProcessState(state: TurnProcessState, event: ConversationEvent): TurnProcessState {
  let current = state
  if (event.type === 'assistant/message'
    && isAppendSurfaceEvent(event)
    && hasAssistantReplyContent(toAssistantBlocks(event.data.message.content))) {
    const messageCountByStep = new Map(current.messageCountByStep)
    messageCountByStep.set(event.data.step, (messageCountByStep.get(event.data.step) ?? 0) + 1)
    current = { ...current, messageCountByStep, messageCount: current.messageCount + 1 }
  }
  if (event.type === 'tool/call') {
    const subagent = isSubagentDelegationTool(event.data.name)
    current = {
      ...current,
      toolCallCount: current.toolCallCount + (subagent ? 0 : 1),
      subagentCount: current.subagentCount + (subagent ? 1 : 0),
    }
  }
  const evidence = processEvidence(event)
  if (evidence === undefined) return current
  if (evidence.kind === 'other') {
    return current.otherStartSeq === undefined
      ? {
        ...current,
        otherStartSeq: evidence.seq,
        controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq),
      }
      : current
  }
  if (current.assistantStartByStep.has(evidence.step)) return current
  const assistantStartByStep = new Map(current.assistantStartByStep)
  assistantStartByStep.set(evidence.step, evidence.seq)
  return {
    ...current,
    assistantStartByStep,
    controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq),
  }
}

/** Turn-scoped process range and answer-boundary Definition. */
export const turnProcessDefinition: ConversationNodeDefinition<TurnProcessState> = {
  kind: 'turn-process',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    const turn = eventTurn(event)
    if (turn === undefined) return null
    if (event.type === 'assistant/live-chunk'
      || event.type === 'assistant/message'
      || event.type === 'assistant/attempt'
      || event.type === 'tool/call'
      || event.type === 'tool/result'
      || event.type === 'llm/retry'
      || event.type === 'step/start'
      || event.type === 'step/end'
      || event.type === 'turn/end') {
      return { id: String(turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-process start requires turn/start')
    return {
      turn: match.event.data.turn,
      assistantStartByStep: new Map(),
      messageCountByStep: new Map(),
      messageCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
    }
  },
  update: (context, match) => updateProcessState(context.state, match.event),
  publication: (match) => {
    if (match.event.type === 'assistant/live-chunk') {
      const type = match.event.data.chunk.type
      return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
    }
    return 'immediate'
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn') return null
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    const turn = turnLocation(context)
    if (turn === undefined) return null
    const current = context.current.get('chat') as ChatNode | null | undefined
    const latestStep = turn.steps.at(-1)
    if (previous?.kind === 'turn'
      && previous.key === 'turn-process'
      && current?.kind === 'turn-process'
      && current.data.answerAnchorSeq === null
      && current.data.controlAnchorSeq === state.controlAnchorSeq
      && current.data.messageCount === state.messageCount
      && current.data.toolCallCount === state.toolCallCount
      && current.data.subagentCount === state.subagentCount
      && turn.status !== 'closed'
      && latestStep?.status !== 'closed') return previous
    const spec = processSpec(state, turn)
    if (spec === null) return null
    if (previous?.kind === 'turn'
      && previous.turn === spec.turn
      && previous.key === 'turn-process'
      && sameTurnProcessSpec(previous.value, spec)) return previous
    return {
      kind: 'turn',
      turn: turn.turn,
      key: 'turn-process',
      value: spec,
    }
  },
  buildViewNode: (context) => {
    const turn = turnLocation(context)
    const data = turn?.data.get('turn-process')
    if (turn === undefined || data === undefined) return null
    const current = context.current.get('chat') as ChatNode | null | undefined
    const state = context.state
    if (current?.kind === 'turn-process'
      && state !== undefined
      && current.data.answerAnchorSeq === null
      && current.data.controlAnchorSeq === state.controlAnchorSeq
      && current.data.messageCount === state.messageCount
      && current.data.toolCallCount === state.toolCallCount
      && current.data.subagentCount === state.subagentCount
      && turn.status !== 'closed'
      && turn.steps.at(-1)?.status !== 'closed'
      && current.location === (context.start?.location ?? context.matches[0]?.location)) return current
    return chatNode(
      context,
      'turn-process',
      data.controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS.processControl,
      data,
    )
  },
}

/**
 * Register the Turn-scoped process disclosure projection.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnProcess(ctx: Context): void {
  ctx.uiConversation.events.register(turnProcessDefinition)
}
