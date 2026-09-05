import type { Context } from '@deepseek-ai/cordis'
import type {
  CommandNode, CompactionSummaryNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CompactionCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { ManualCompactionChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary slash-command lifecycle. */
    command: CommandNode
    /** Manual compact command combined with its compaction transaction. */
    'manual-compaction': ManualCompactionChatData
  }
}

type CommandId = CommandNode['commandId']

const COMPACT_PLUGIN: CompactionCheckpointSource['plugin'] = 'compact'

interface CommandState {
  readonly command: CommandNode
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

interface CompactionEvidence {
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function commandFromRun(match: ConversationMatch): CommandNode {
  if (match.event.type !== 'command/run') throw new Error('command start requires command/run')
  const data = match.event.data
  return {
    kind: 'command',
    seq: match.event.seq,
    time: match.event.time,
    commandId: data.commandId,
    name: data.name,
    args: data.args ?? null,
    outcome: null,
  }
}

function commandFromDone(match: ConversationMatch, previous?: CommandNode): CommandNode {
  if (match.event.type !== 'command/done') throw new Error('command update requires command/done')
  const data = match.event.data
  const sourceEventSeq = data.kind === 'success'
    && data.sourceEventSeq !== undefined
    && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0
    ? data.sourceEventSeq
    : undefined
  return {
    kind: 'command',
    seq: previous?.seq ?? match.event.seq,
    time: previous?.time ?? match.event.time,
    commandId: data.commandId,
    name: previous?.name ?? null,
    args: previous?.args ?? null,
    outcome: {
      kind: data.kind,
      ...data.text === undefined ? {} : { text: data.text },
      ...sourceEventSeq === undefined ? {} : { sourceEventSeq },
    },
  }
}

/**
 * Read correlation identity from a compaction replacement checkpoint.
 * @param event - candidate Session event.
 * @returns correlated compaction and optional command identity.
 */
function compactSource(event: Parameters<ConversationNodeDefinition['match']>[0]): {
  compactionId: string
  sourceCommandId?: CommandId
} | undefined {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return undefined
  const source = event.data.source as unknown as {
    kind?: unknown
    plugin?: unknown
    compactionId?: unknown
    sourceCommandId?: CommandId
  }
  if (source.kind !== 'plugin' || source.plugin !== COMPACT_PLUGIN || typeof source.compactionId !== 'string') return undefined
  return {
    compactionId: source.compactionId,
    ...source.sourceCommandId === undefined ? {} : { sourceCommandId: source.sourceCommandId },
  }
}

/**
 * Build the visible summary marker from optional lifecycle evidence.
 * @param match - compaction/summary Match, when loaded.
 * @param checkpoint - replacement checkpoint Match.
 * @returns final compaction summary Node data.
 */
function compactSummary(match: ConversationMatch | undefined, checkpoint: ConversationMatch): CompactionSummaryNode {
  let summary: string | null = null
  let shadowedItemCount: number | null = null
  let shadowedTokenCount: number | null = null
  if (match?.event.type === 'compaction/summary') {
    const data = match.event.data
    if (Array.isArray(data.summary)) {
      const text = data.summary
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      summary = text.trim() === '' ? null : text
    }
    shadowedItemCount = Array.isArray(data.shadowedSeqs)
      && data.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
      ? data.shadowedSeqs.length
      : null
    shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount)
      && data.shadowedTokenCount >= 0
      ? data.shadowedTokenCount
      : null
  }
  return {
    kind: 'compaction',
    seq: checkpoint.event.seq,
    time: checkpoint.event.time,
    summary,
    summaryEventSeq: match?.event.seq ?? null,
    shadowedItemCount,
    shadowedTokenCount,
  }
}

function fallbackState(context: ConversationNodeContext<CommandState>): CommandState | undefined {
  const done = context.matches.find(match => match.event.type === 'command/done')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  if (checkpoint === undefined) return done === undefined ? undefined : { command: commandFromDone(done) }
  const source = compactSource(checkpoint.event)
  if (source?.sourceCommandId === undefined) return done === undefined ? undefined : { command: commandFromDone(done) }
  const fallbackCommand = done === undefined
    ? {
      kind: 'command' as const,
      seq: checkpoint.event.seq,
      time: checkpoint.event.time,
      commandId: source.sourceCommandId,
      name: 'compact',
      args: null,
      outcome: null,
    }
    : { ...commandFromDone(done), name: 'compact' }
  return {
    command: fallbackCommand,
    checkpoint,
    ...summary === undefined ? {} : { summary },
  }
}

/**
 * Fold shared compaction evidence into a Definition-owned State.
 * @param state - current business State carrying optional compaction evidence.
 * @param match - next compaction lifecycle Match.
 * @returns adopted State, preserving reference identity when the Match adds no evidence.
 */
export function updateCompactionState<State extends CompactionEvidence>(
  state: State,
  match: ConversationMatch,
): State {
  if (match.event.type === 'compaction/summary') return { ...state, summary: match }
  if (compactSource(match.event) !== undefined) return { ...state, checkpoint: match }
  return state
}

/** Slash-command lifecycle, including integrated manual compaction, Definition. */
export const commandDefinition: ConversationNodeDefinition<CommandState> = {
  kind: 'command',
  target: 'chat',
  match: (event) => {
    if (event.type === 'command/run') {
      return { id: String(event.data.commandId), role: 'start' }
    }
    if (event.type === 'command/done') {
      return { id: String(event.data.commandId), role: 'update' }
    }
    const checkpoint = compactSource(event)
    if (checkpoint?.sourceCommandId !== undefined) {
      return { id: String(checkpoint.sourceCommandId), role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) {
        return { id: String(event.data.sourceCommandId), role: 'update' }
      }
    }
    return null
  },
  start: (_context, match) => ({ command: commandFromRun(match) }),
  update: (context, match) => {
    if (match.event.type === 'command/done') {
      return { ...context.state, command: commandFromDone(match, context.state.command) }
    }
    return updateCompactionState(context.state, match)
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    if (state.command.name !== 'compact') {
      return chatNode(context, 'command', state.command.seq, state.command)
    }
    const compaction = state.checkpoint === undefined
      ? null
      : compactSummary(state.summary, state.checkpoint)
    const data: ManualCompactionChatData = { command: state.command, compaction }
    return chatNode(context, 'manual-compaction', compaction?.seq ?? state.command.seq, data)
  },
}

/**
 * Register the command lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCommandConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(commandDefinition)
}

/** Shared structural checkpoint recognizer for automatic compaction. */
export { compactSource, compactSummary }
