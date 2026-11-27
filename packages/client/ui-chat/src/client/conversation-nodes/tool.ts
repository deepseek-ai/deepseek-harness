import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, PreparingToolCall, StartedToolCall,
  ToolCallBlock, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-tool-registry-ptc/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ChatNode, ToolChatData } from '../contract/chat-nodes.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode, contextLocation } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Root Tool lifecycle with recursively nested subcalls. */
    'tool-call': ToolChatData
  }
}

const MAX_DEPTH = 256

/**
 * Fold State of one root Tool call. Dispatch updates mutate it in place and return the same object, as the
 * [Assembler update rule](../../../../../../.agents/notes/implemented/architecture/2026-08-09-client-conversation-node-assembly.md)
 * permits.
 */
interface ToolState {
  /** Absent until a named delta or `tool/call` identifies the call. */
  root: ToolCallBlock | undefined
  /** Dispatch edges accumulated by incremental updates. */
  calls: DispatchTree
}

/**
 * Nested dispatch edges, keyed by parent then child call id and mutated in place
 * ([rationale](../../../../../../.agents/notes/implemented/bug-fix/2026-11-27-ptc-dispatch-fold-quadratic.md)).
 * Published Tool call blocks carry their own arrays and never alias this tree.
 */
interface DispatchTree {
  /** Children of each parent, in dispatch order. */
  children: Map<string, Map<string, ToolCallBlock>>
  parents: Map<string, string>
}

function emptyDispatchTree(): DispatchTree {
  return { children: new Map(), parents: new Map() }
}

interface ProjectedBlockCache {
  readonly children: readonly ToolCallBlock[]
  readonly interruptionSeq: number | undefined
  readonly interruptionTime: number | undefined
  readonly value: ToolCallBlock
}

const projectedBlocks = new WeakMap<ToolCallBlock, ProjectedBlockCache>()

function jsonArguments(value: unknown): string {
  return JSON.stringify(value)
}

function rootCall(match: ConversationMatch, previous?: ToolCallBlock): StartedToolCall {
  if (match.event.type !== 'tool/call') throw new Error('tool-call start requires tool/call')
  return {
    phase: 'start',
    callId: String(match.event.data.callId),
    name: match.event.data.name,
    argsRaw: match.event.data.arguments,
    args: previous === undefined
      ? PartialArguments.fromText(match.event.data.arguments)
      : previous.args.settle(match.event.data.arguments),
    turn: match.event.data.turn,
    step: match.event.data.step,
    time: match.event.time,
    subCalls: [],
  }
}

/**
 * Retain argument fragments in the named call's lazy view. Root replacement
 * belongs to publication, after all pending fragments can be observed together.
 */
function applyDelta(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (event.type !== 'assistant/live-chunk') return state
  const chunk = event.data.chunk
  const root = state.root
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    if (root === undefined || 'kind' in root || root.phase !== 'preparing') return state
    return { ...state, root: { ...root, name: chunk.block.name, args: root.args.settle(chunk.block.arguments) } }
  }
  if (chunk.type !== 'tool-call-delta') return state
  if (root === undefined) {
    // An unnamed delta before the name is skipped; a view opened late sees a non-object prefix and reports nothing.
    if (!chunk.name) return state
    const args = new PartialArguments()
    args.append(chunk.argumentsDelta)
    return {
      ...state,
      root: {
        phase: 'preparing',
        callId: String(chunk.id), name: chunk.name,
        turn: event.data.turn, step: event.data.step, time: event.time,
        subCalls: [],
        args,
      },
    }
  }
  if ('kind' in root || root.phase !== 'preparing' || root.args.isSealed) return state
  root.args.append(chunk.argumentsDelta)
  return state
}

function preparingBlock(root: PreparingToolCall, current: ToolCallBlock | undefined): PreparingToolCall {
  const changed = root.args.refresh()
  if (!changed && current !== undefined && !('kind' in current)
    && current.phase === 'preparing' && current.name === root.name && current.args === root.args) return current
  return changed ? { ...root } : root
}

function rootResult(match: ConversationMatch, previous?: StartedToolCall): ToolResultNode | undefined {
  if (match.event.type !== 'tool/result') return undefined
  const message = match.event.data.message
  return {
    kind: 'tool-result',
    seq: match.event.seq,
    time: match.event.time,
    callId: String(message.source.callId),
    name: previous?.name ?? '',
    args: previous?.args ?? PartialArguments.EMPTY,
    call: previous === undefined ? null : { name: previous.name, argsRaw: previous.argsRaw },
    callTime: previous?.time ?? null,
    content: message.content,
    isError: message.isError === true,
    ...match.event.data.error === undefined ? {} : { error: match.event.data.error },
    meta: match.event.data.meta,
    subCalls: [],
  }
}

interface DispatchData {
  readonly parentCallId: string
  readonly subCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly isError?: boolean
  readonly error?: { name: string; code: string; reason?: string }
  readonly content?: ToolResultNode['content']
  readonly meta?: ToolResultNode['meta']
}

function childCall(match: ConversationMatch, data: DispatchData): StartedToolCall {
  return {
    phase: 'start',
    callId: data.subCallId,
    parentCallId: data.parentCallId,
    name: data.name,
    argsRaw: jsonArguments(data.arguments),
    args: PartialArguments.fromObject(data.arguments),
    turn: locationTurn(match),
    step: locationStep(match),
    time: match.event.time,
    subCalls: [],
  }
}

function childResult(match: ConversationMatch, data: DispatchData, previous?: ToolCallBlock): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: match.event.seq,
    time: match.event.time,
    callId: data.subCallId,
    parentCallId: data.parentCallId,
    name: data.name,
    args: previous !== undefined && !('kind' in previous) ? previous.args : PartialArguments.fromObject(data.arguments),
    call: { name: data.name, argsRaw: jsonArguments(data.arguments) },
    callTime: previous?.time ?? null,
    content: data.content ?? [],
    meta: data.meta,
    isError: data.isError === true,
    ...data.error === undefined ? {} : { error: data.error },
    subCalls: [],
  }
}

function locationTurn(match: ConversationMatch): number {
  return match.location.kind === 'step' || match.location.kind === 'turn' ? match.location.turn.turn : 0
}

function locationStep(match: ConversationMatch): number {
  return match.location.kind === 'step' ? match.location.step.step : 0
}

function acceptsEdge(state: ToolState, parent: string, child: string): boolean {
  if (parent === child || state.calls.parents.has(child)) return false
  let cursor: string | undefined = parent
  let parentDepth = 0
  const ancestors = new Set<string>()
  while (cursor !== undefined) {
    if (cursor === child || ancestors.has(cursor)) return false
    ancestors.add(cursor)
    parentDepth++
    cursor = state.calls.parents.get(cursor)
  }
  const pending = [{ callId: child, depth: 1 }]
  const descendants = new Set<string>()
  let subtreeDepth = 0
  for (const candidate of pending) {
    if (descendants.has(candidate.callId)) return false
    descendants.add(candidate.callId)
    subtreeDepth = Math.max(subtreeDepth, candidate.depth)
    for (const nested of state.calls.children.get(candidate.callId)?.values() ?? []) {
      pending.push({ callId: nested.callId, depth: candidate.depth + 1 })
    }
  }
  return parentDepth + subtreeDepth <= MAX_DEPTH
}

function updateDispatch(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return state
  const data = event.data
  const parentCallId = String(data.parentCallId)
  const subCallId = String(data.subCallId)
  const previous = state.calls.children.get(parentCallId)?.get(subCallId)
  if (event.type === 'tool/ptc-dispatch-start') {
    if (previous !== undefined || !acceptsEdge(state, parentCallId, subCallId)) return state
    attachChild(state.calls, parentCallId, childCall(match, data))
    return state
  }
  if (previous === undefined && !acceptsEdge(state, parentCallId, subCallId)) return state
  attachChild(state.calls, parentCallId, childResult(match, data, previous))
  return state
}

/** Record one child under its parent, keeping first-attachment order on replacement. */
function attachChild(calls: DispatchTree, parentCallId: string, child: ToolCallBlock): void {
  let siblings = calls.children.get(parentCallId)
  if (siblings === undefined) {
    siblings = new Map()
    calls.children.set(parentCallId, siblings)
  }
  siblings.set(child.callId, child)
  calls.parents.set(child.callId, parentCallId)
}

function projectBlock(
  block: ToolCallBlock,
  state: ToolState,
  interruptedAt: { seq: number; time: number } | undefined,
  visited = new Set<string>(),
  depth = 1,
): ToolCallBlock {
  if (!('kind' in block) && block.phase === 'preparing') return block
  if (visited.has(block.callId) || depth > MAX_DEPTH) return { ...block, subCalls: [] }
  const nextVisited = new Set(visited)
  nextVisited.add(block.callId)
  const attached = state.calls.children.get(block.callId)
  const children = (attached === undefined ? block.subCalls : [...attached.values()])
    .map(child => projectBlock(child, state, interruptedAt, nextVisited, depth + 1))
  const interruptionSeq = 'kind' in block ? undefined : interruptedAt?.seq
  const interruptionTime = 'kind' in block ? undefined : interruptedAt?.time
  const cached = projectedBlocks.get(block)
  if (cached !== undefined
    && cached.interruptionSeq === interruptionSeq
    && cached.interruptionTime === interruptionTime
    && sameReferences(cached.children, children)) {
    return cached.value
  }
  const projected: ToolCallBlock = 'kind' in block || interruptedAt === undefined
    ? sameReferences(block.subCalls, children) ? block : { ...block, subCalls: children }
    : {
      kind: 'tool-result',
      seq: interruptedAt.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
      time: interruptedAt.time,
      callId: block.callId,
      ...block.parentCallId === undefined ? {} : { parentCallId: block.parentCallId },
      name: block.name,
      args: block.args,
      call: { name: block.name, argsRaw: block.argsRaw },
      callTime: block.time,
      content: [],
      isError: true,
      error: { name: 'Interrupted', code: 'interrupted' },
      subCalls: children,
    }
  projectedBlocks.set(block, { children, interruptionSeq, interruptionTime, value: projected })
  return projected
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function interruption(context: ConversationNodeContext<ToolState>): { seq: number; time: number } | undefined {
  const location = context.start?.location
  if (location?.kind === 'step' && location.step.status === 'closed') return location.step.end
  if ((location?.kind === 'step' || location?.kind === 'turn') && location.turn.status === 'closed') {
    return location.turn.end
  }
  return undefined
}

function fallbackState(context: ConversationNodeContext<ToolState>): ToolState | undefined {
  const match = context.matches.find(candidate => candidate.event.type === 'tool/result')
  const root = match === undefined ? undefined : rootResult(match)
  if (root === undefined) return undefined
  let state: ToolState = { root, calls: emptyDispatchTree() }
  for (const candidate of context.matches) state = updateDispatch(state, candidate)
  return state
}

/** Root Tool preparation, dispatch, result, and nested PTC calls. */
export const toolDefinition: ConversationNodeDefinition<ToolState> = {
  kind: 'tool-call',
  target: 'chat',
  match: (event) => {
    if (event.type === 'assistant/live-chunk') {
      // Every delta of a call is a start candidate: the earliest opens the Context, later ones fold as updates.
      const chunk = event.data.chunk
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        return { id: String(chunk.block.id), role: 'start' }
      }
      return chunk.type === 'tool-call-delta' ? { id: String(chunk.id), role: 'start' } : null
    }
    if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const rootCallId: unknown = event.data.rootCallId
      return typeof rootCallId === 'string' && rootCallId !== ''
        ? { id: rootCallId, role: 'update' }
        : null
    }
    return null
  },
  start: (_context, match) => {
    const state: ToolState = { root: undefined, calls: emptyDispatchTree() }
    return match.event.type === 'tool/call' ? { ...state, root: rootCall(match) } : applyDelta(state, match)
  },
  update: (context, match) => {
    if (match.event.type === 'assistant/live-chunk') return applyDelta(context.state, match)
    if (match.event.type === 'tool/call') return { ...context.state, root: rootCall(match, context.state.root) }
    if (match.event.type === 'tool/result') {
      const root = context.state.root
      const running = root !== undefined && !('kind' in root) && root.phase === 'start' ? root : undefined
      const result = rootResult(match, running)
      return result === undefined ? context.state : { ...context.state, root: result }
    }
    return updateDispatch(context.state, match)
  },
  publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate',
  buildViewNode: (context) => {
    const current = context.current.get('chat') as ChatNode<'tool-call'> | null | undefined
    const state = context.state ?? fallbackState(context)
    if (state?.root === undefined) {
      return current == null ? null : current.visibility === 'hidden' ? current : { ...current, visibility: 'hidden' }
    }
    const interruptedAt = interruption(context)
    const root = !('kind' in state.root) && state.root.phase === 'preparing'
      ? preparingBlock(state.root, current?.data.root)
      : state.root
    const projected = projectBlock(root, state, interruptedAt)
    const anchor = context.start?.event.seq
      ?? ('kind' in state.root ? state.root.seq : context.matches[0]?.event.seq ?? 0)
    const preparing = !('kind' in projected) && projected.phase === 'preparing'
    const visibility = preparing && interruptedAt !== undefined ? 'hidden' : 'visible'
    const location = contextLocation(context)
    const data = current?.data.root === projected ? current.data : { root: projected } satisfies ToolChatData
    if (current?.data === data && current.anchorSeq === anchor
      && current.visibility === visibility && current.location === location) return current
    return chatNode(context, 'tool-call', anchor, data, { visibility, location })
  },
}

/**
 * Register the root Tool lifecycle and nested-subcall contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerToolConversationNode(ctx: Context): void {
  const match = toolDefinition.match.bind(toolDefinition)
  ctx.uiConversation.events.register({
    ...toolDefinition,
    match: {
      'assistant/live-chunk': match,
      'tool/call': match,
      'tool/result': match,
      'tool/ptc-dispatch-start': match,
      'tool/ptc-dispatch': match,
    },
  })
}
