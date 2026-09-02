import type {
  AssistantChatData, AssistantMessageNode, ChatConversationViewNode, ChatNode, ChatSnapshot, ConversationNode,
  ChatLocationNodeIndex, ChatNodeProcessSource, ChatNodeSource, ChatNodeStore,
  ChatTurnProcessPresentation, CompactionSummaryNode, FinalAssistantChatData, LegacyConversationSlice,
  PartialAssistant, RunningToolCall, ToolCallBlock, TurnNavigationItem,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationLocationDataSource, ConversationLocationDataStore, ConversationTurnDataMap, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnTokenUsage } from '../src/client/contract/chat-nodes.ts'
import { deriveTurnMetrics } from '../src/client/contract/turn-metrics.ts'
import {
  sameTurnNavigationItem, turnNavigationItem,
} from '../src/client/conversation-nodes/turn-navigation.ts'
import { orderedVisibleChatNodes } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ChatTurnProcessProjector } from '../src/client/conversation-nodes/turn-process-presentation.ts'
import { hasAssistantReplyContent } from '../src/client/contract/assistant-content.ts'
import {
  isSubagentDelegationTool, sameTurnProcessSpec, TURN_PROCESS_INDEPENDENT_KINDS,
  type TurnProcessSpec,
} from '../src/client/contract/turn-process.ts'

const EMPTY: readonly never[] = []

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function cachedSource<Key, Source>(
  sources: Map<Key, Source>,
  key: Key,
  create: () => Source,
): Source {
  let source = sources.get(key)
  if (source === undefined) {
    source = create()
    sources.set(key, source)
  }
  return source
}

function sameFixtureLocation(
  left: ChatConversationViewNode['location'],
  right: ChatConversationViewNode['location'],
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'session' || left.kind === 'unresolved') return true
  if (right.kind === 'session' || right.kind === 'unresolved') return false
  if (left.turn.turn !== right.turn.turn
    || left.turn.status !== right.turn.status
    || left.turn.start !== right.turn.start
    || left.turn.end !== right.turn.end
    || left.turn.data !== right.turn.data) return false
  if (left.kind === 'turn' || right.kind === 'turn') return left.kind === right.kind
  return left.step.step === right.step.step
    && left.step.status === right.step.status
    && left.step.start === right.step.start
    && left.step.end === right.step.end
    && left.step.data === right.step.data
}

function nodeSource(node: ChatConversationViewNode): unknown {
  if (node.kind === 'assistant-step') {
    const data = node.data as AssistantChatData
    return data.finalNode ?? data.blocks
  }
  if (node.kind === 'tool-call') return (node.data as { readonly root: ToolCallBlock }).root
  if (node.kind === 'model-retry') return (node.data as { readonly current: unknown }).current
  if (node.kind === 'turn-tail') return (node.data as { readonly seq: number }).seq
  if (node.kind === 'turn-process') return node.data
  return node.data
}

function toolCallName(call: ToolCallBlock): string | null {
  return 'name' in call ? call.name : call.call?.name ?? null
}

class FixtureSource<Value> {
  private readonly listeners = new Set<() => void>()
  private published: Value

  constructor(
    private readonly read: () => Value,
  ) {
    this.published = read()
  }

  readonly getSnapshot = (): Value => this.read()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(): void {
    const next = this.getSnapshot()
    if (this.published === next) return
    this.published = next
    for (const listener of [...this.listeners]) listener()
  }
}

class FixtureNodeStore implements ChatNodeStore {
  private byKey = new Map<string, ChatConversationViewNode>()
  private readonly turnProcesses = new ChatTurnProcessProjector()
  private readonly sources = new Map<string, FixtureSource<ChatConversationViewNode | undefined>>()
  private readonly processSources = new Map<string, FixtureSource<ChatTurnProcessPresentation | undefined>>()
  private readonly dirtyKeys = new Set<string>()
  private readonly dirtyProcessKeys = new Set<string>()
  private list: readonly ChatConversationViewNode[] = EMPTY

  get(key: string): ChatConversationViewNode | undefined {
    return this.byKey.get(key)
  }

  source(key: string): ChatNodeSource {
    return cachedSource(this.sources, key, () => new FixtureSource(() => this.get(key)))
  }

  processSource(key: string): ChatNodeProcessSource {
    return cachedSource(this.processSources, key, () => new FixtureSource(() => this.process(key)))
  }

  process(key: string): ChatTurnProcessPresentation | undefined {
    return this.turnProcesses.get(this.get(key) as ChatNode | undefined)
  }

  values(): readonly ChatConversationViewNode[] {
    return this.list
  }

  replace(candidates: readonly ChatConversationViewNode[]): void {
    const previous = this.byKey
    const next = new Map<string, ChatConversationViewNode>()
    const list = candidates.map((candidate) => {
      const existing = previous.get(candidate.key)
      const node = existing !== undefined
        && existing.kind === candidate.kind
        && existing.anchorSeq === candidate.anchorSeq
        && sameFixtureLocation(existing.location, candidate.location)
        && existing.visibility === candidate.visibility
        && nodeSource(existing) === nodeSource(candidate)
        ? existing
        : candidate
      next.set(node.key, node)
      return node
    })
    this.byKey = next
    this.list = sameValues(this.list, list) ? this.list : list
    const keys = new Set([...previous.keys(), ...next.keys()])
    for (const key of keys) {
      if (previous.get(key) !== next.get(key)) {
        this.dirtyKeys.add(key)
        this.dirtyProcessKeys.add(key)
      }
    }
  }

  replaceProcesses(order: readonly string[], locations: ChatLocationNodeIndex): void {
    const changed = this.turnProcesses.replace(order, locations, this)
    for (const turn of changed) {
      for (const key of locations.getTurn(turn)) this.dirtyProcessKeys.add(key)
    }
  }

  publish(): void {
    const dirty = [...this.dirtyKeys]
    const dirtyProcesses = [...this.dirtyProcessKeys]
    this.dirtyKeys.clear()
    this.dirtyProcessKeys.clear()
    for (const key of dirty) this.sources.get(key)?.publish()
    for (const key of dirtyProcesses) this.processSources.get(key)?.publish()
  }
}

class FixtureLocationIndex implements ChatLocationNodeIndex {
  private turns = new Map<number, readonly string[]>()

  getTurn(turn: number): readonly string[] {
    return this.turns.get(turn) ?? EMPTY
  }

  getStep(): readonly string[] {
    return EMPTY
  }

  replace(next: ReadonlyMap<number, readonly string[]>): void {
    const stable = new Map<number, readonly string[]>()
    for (const [turn, keys] of next) {
      const previous = this.turns.get(turn) ?? EMPTY
      stable.set(turn, sameValues(previous, keys) ? previous : keys)
    }
    this.turns = stable
  }
}

class FixtureTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()
  private readonly sources = new Map<string, FixtureSource<unknown>>()
  private readonly dirtyKeys = new Set<string>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  source<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined> {
    const source = cachedSource(this.sources, key, () => new FixtureSource(() => this.values.get(key)))
    return source as ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined>
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    if (this.values.get(key) === value) return
    this.values.set(key, value)
    this.dirtyKeys.add(key)
  }

  publish(): void {
    const dirty = [...this.dirtyKeys]
    this.dirtyKeys.clear()
    for (const key of dirty) this.sources.get(key)?.publish()
  }
}

function assistantData(node: AssistantMessageNode): FinalAssistantChatData {
  return {
    status: node.interrupted === true ? 'interrupted' as const : 'settled' as const,
    turn: node.turn,
    step: node.step,
    blocks: node.blocks,
    time: node.time,
    finalNode: node,
  }
}

function settledNode(
  node: ConversationNode,
  turns: ReadonlyMap<number, TurnLocation>,
  inferredTurn?: number,
): ChatConversationViewNode {
  const ownTurn = 'turn' in node && typeof node.turn === 'number' ? node.turn : inferredTurn
  const turn = ownTurn === undefined ? undefined : turns.get(ownTurn)
  const base = {
    key: `fixture:${node.kind}:${node.seq}`,
    id: String(node.seq),
    target: 'chat' as const,
    anchorSeq: node.seq,
    location: turn === undefined
      ? { kind: 'session' as const }
      : { kind: 'turn' as const, turn },
    visibility: 'visible' as const,
  }
  switch (node.kind) {
    case 'assistant':
      return { ...base, kind: 'assistant-step', data: assistantData(node) }
    case 'tool-result':
      return { ...base, key: `fixture:tool:${node.callId}`, kind: 'tool-call', data: { root: node } }
    case 'model-retry':
      return { ...base, key: 'fixture:model-retry', kind: 'model-retry', data: { attempts: [node], current: node } }
    default:
      return { ...base, kind: node.kind, data: node }
  }
}

/** Build the canonical Chat fixture corresponding to one legacy test slice. */
export function chatSnapshotFixture(input: {
  readonly nodes?: readonly ConversationNode[]
  readonly partial?: PartialAssistant | null
  readonly runningCalls?: readonly RunningToolCall[]
  readonly turnTimings?: LegacyConversationSlice['turnTimings']
  readonly turnEnds?: LegacyConversationSlice['turnEnds']
  /** Per-turn usage buckets; production derives these from session events. */
  readonly turnUsages?: ReadonlyMap<number, TurnTokenUsage> | undefined
} = {}, previous?: ChatSnapshot): ChatSnapshot {
  const legacy: LegacyConversationSlice = {
    nodes: input.nodes ?? EMPTY,
    partial: input.partial ?? null,
    runningCalls: input.runningCalls ?? EMPTY,
    turnTimings: input.turnTimings ?? new Map(),
    turnEnds: input.turnEnds ?? new Map(),
  }
  const turnNumbers = new Set([...legacy.turnTimings.keys(), ...legacy.turnEnds.keys()])
  for (const node of legacy.nodes) {
    if ('turn' in node && typeof node.turn === 'number') turnNumbers.add(node.turn)
  }
  if (legacy.partial !== null) turnNumbers.add(legacy.partial.turn)
  for (const call of legacy.runningCalls) turnNumbers.add(call.turn)
  const turns = new Map<number, TurnLocation>()
  const turnData = new Map<number, FixtureTurnDataStore>()
  for (const turn of [...turnNumbers].sort((left, right) => left - right)) {
    const timing = legacy.turnTimings.get(turn)
    const endSeq = legacy.turnEnds.get(turn)
    const previousData = previous?.timeline.turns.get(turn)?.data
    const data = previousData instanceof FixtureTurnDataStore ? previousData : new FixtureTurnDataStore()
    turnData.set(turn, data)
    turns.set(turn, {
      turn,
      start: timing === undefined ? undefined : {
        type: 'turn/start', seq: Math.max(0, (endSeq ?? 1) - 1), time: timing.startTime, turn,
      } as never,
      end: timing?.endTime === undefined || endSeq === undefined ? undefined : {
        type: 'turn/end', seq: endSeq, time: timing.endTime, turn, reason: 'completed',
      } as never,
      status: endSeq === undefined ? 'open' : 'closed',
      steps: EMPTY,
      data,
    })
  }
  const linkedCompactions = new Set<CompactionSummaryNode>()
  const nodes = legacy.nodes.flatMap((node, index): ChatConversationViewNode[] => {
    if (node.kind === 'command' && node.name === 'compact') {
      const sourceSeq = node.outcome?.kind === 'success' ? node.outcome.sourceEventSeq : undefined
      const candidates = sourceSeq === undefined
        ? []
        : legacy.nodes.filter((candidate): candidate is CompactionSummaryNode =>
          candidate.kind === 'compaction' && candidate.summaryEventSeq === sourceSeq)
      const compaction = candidates.length === 1 ? candidates[0] : undefined
      if (node.outcome === null || compaction !== undefined) {
        if (compaction !== undefined) linkedCompactions.add(compaction)
        const base = settledNode(node, turns)
        return [{
          ...base,
          key: `fixture:manual-compaction:${node.commandId}`,
          kind: 'manual-compaction',
          anchorSeq: compaction?.seq ?? node.seq,
          data: { command: node, compaction: compaction ?? null },
        }]
      }
    }
    if (node.kind === 'compaction' && linkedCompactions.has(node)) return []
    const inferredTurn = node.kind === 'tool-result'
      ? legacy.nodes.slice(0, index).findLast(
        (candidate): candidate is AssistantMessageNode => candidate.kind === 'assistant',
      )?.turn
      : undefined
    return [settledNode(node, turns, inferredTurn)]
  })
  if (legacy.partial !== null) {
    const turn = turns.get(legacy.partial.turn)
    nodes.push({
      key: `fixture:assistant:${legacy.partial.turn}:${legacy.partial.step}`,
      id: `${legacy.partial.turn}:${legacy.partial.step}`,
      target: 'chat',
      kind: 'assistant-step',
      anchorSeq: Number.MAX_SAFE_INTEGER - 1,
      location: turn === undefined ? { kind: 'session' } : { kind: 'turn', turn },
      visibility: 'visible',
      data: {
        status: 'running',
        turn: legacy.partial.turn,
        step: legacy.partial.step,
        blocks: legacy.partial.blocks,
        time: 0,
      },
    })
  }
  for (const call of legacy.runningCalls) {
    const turn = turns.get(call.turn)
    nodes.push({
      key: `fixture:tool:${call.callId}`,
      id: call.callId,
      target: 'chat',
      kind: 'tool-call',
      anchorSeq: Number.MAX_SAFE_INTEGER,
      location: turn === undefined ? { kind: 'session' } : { kind: 'turn', turn },
      visibility: 'visible',
      data: { root: call },
    })
  }
  for (const [turnNumber, dataStore] of turnData) {
    const inTurn = nodes.filter((candidate) => {
      const location = candidate.location
      return (location.kind === 'turn' || location.kind === 'step') && location.turn.turn === turnNumber
    })
    const assistants = inTurn
      .filter(candidate => candidate.kind === 'assistant-step')
      .map(candidate => candidate.data as AssistantChatData)
    const toolCalls = inTurn
      .filter(candidate => candidate.kind === 'tool-call')
      .map(candidate => (candidate.data as { readonly root: ToolCallBlock }).root)
    const latestStep = Math.max(
      0,
      ...assistants.map(candidate => candidate.step),
      ...inTurn.flatMap((candidate) => {
        if (candidate.kind !== 'tool-call') return []
        const root = (candidate.data as { root: ToolCallBlock }).root as ToolCallBlock & { step?: unknown }
        const step: unknown = root.step
        return typeof step === 'number' ? [step] : []
      }),
    )
    const answer = assistants.findLast((candidate): candidate is FinalAssistantChatData =>
      candidate.step === latestStep
      && candidate.finalNode !== undefined
      && hasAssistantReplyContent(candidate.blocks)
      && !candidate.blocks.some(block => block.kind === 'tool-call'))
    const controlAnchor = inTurn.find(candidate => candidate.kind === 'assistant-step'
      || candidate.kind === 'tool-call'
      || candidate.kind === 'model-retry')
    if (controlAnchor === undefined) continue
    const processStart = inTurn.find(candidate => !TURN_PROCESS_INDEPENDENT_KINDS.has(candidate.kind))
      ?? controlAnchor
    const inlineReasoning = answer?.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '') === true
    const candidate: TurnProcessSpec = {
      turn: turnNumber,
      controlAnchorSeq: controlAnchor.anchorSeq,
      processStartSeq: processStart.anchorSeq,
      answerAnchorSeq: answer?.finalNode.seq ?? null,
      answerStep: answer?.step ?? null,
      inlineReasoning: answer !== undefined && inlineReasoning,
      messageCount: answer === undefined
        ? assistants.filter(candidate => hasAssistantReplyContent(candidate.blocks)).length
        : assistants.filter(candidate => candidate.step < answer.step
          && hasAssistantReplyContent(candidate.blocks)).length,
      toolCallCount: toolCalls.filter((call) => {
        const name = toolCallName(call)
        return name === null || !isSubagentDelegationTool(name)
      }).length,
      subagentCount: toolCalls.filter((call) => {
        const name = toolCallName(call)
        return name !== null && isSubagentDelegationTool(name)
      }).length,
    }
    const previousSpec = dataStore.get('turn-process')
    const spec = previousSpec !== undefined && sameTurnProcessSpec(previousSpec, candidate)
      ? previousSpec
      : candidate
    dataStore.set('turn-process', spec)
    const turn = turns.get(turnNumber)
    if (turn !== undefined) {
      nodes.push({
        key: `fixture:turn-process:${String(turnNumber)}`,
        id: String(turnNumber),
        target: 'chat',
        kind: 'turn-process',
        anchorSeq: spec.controlAnchorSeq - 0.1,
        location: { kind: 'turn', turn },
        visibility: 'visible',
        data: spec,
      })
    }
  }
  nodes.sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
  for (const [turnNumber, endSeq] of legacy.turnEnds) {
    const turn = turns.get(turnNumber)
    const dataStore = turnData.get(turnNumber)
    if (turn === undefined || dataStore === undefined) continue
    const closing = legacy.nodes
      .filter((candidate): candidate is AssistantMessageNode => candidate.kind === 'assistant'
        && candidate.turn === turnNumber
        && candidate.blocks.some(block => block.kind === 'text' && block.text.trim() !== ''))
      .map(assistantData)
      .at(-1) ?? null
    const preceding = nodes.findLast((candidate) => {
      const location = candidate.location
      return (location.kind === 'turn' || location.kind === 'step')
        && location.turn.turn === turnNumber
    })
    const metrics = deriveTurnMetrics(legacy.nodes).get(turnNumber)
    const tokenUsage = input.turnUsages?.get(turnNumber)
    const tailData = {
      turn: turnNumber,
      seq: endSeq,
      time: turn.end?.time ?? 0,
      closing,
      branchUnavailable: closing === null
        || preceding?.kind !== 'assistant-step'
        || (preceding.data as ReturnType<typeof assistantData>).finalNode.seq !== closing.finalNode.seq,
      ...metrics?.ttftMs === undefined ? {} : { ttftMs: metrics.ttftMs },
      ...metrics?.tokensPerSecond === undefined ? {} : { tokensPerSecond: metrics.tokensPerSecond },
      ...tokenUsage === undefined ? {} : { tokenUsage },
    }
    dataStore.set('turn-tail', tailData)
    nodes.push({
      key: `fixture:turn-tail:${turnNumber}`,
      id: String(turnNumber),
      target: 'chat',
      kind: 'turn-tail',
      anchorSeq: endSeq,
      location: { kind: 'turn', turn },
      visibility: 'visible',
      data: tailData,
    })
  }
  nodes.sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
  const ordered = orderedVisibleChatNodes(nodes)
  const store = previous?.nodes instanceof FixtureNodeStore ? previous.nodes : new FixtureNodeStore()
  store.replace(ordered)
  const byKey = new Map(store.values().map(node => [node.key, node]))
  const nextOrder = ordered.map(node => node.key)
  const order = previous !== undefined && sameValues(previous.order, nextOrder) ? previous.order : nextOrder
  const byTurn = new Map<number, readonly string[]>()
  for (const turn of turns.keys()) {
    byTurn.set(turn, order.filter((key) => {
      const location = byKey.get(key)?.location
      return location?.kind === 'turn' && location.turn.turn === turn
        || location?.kind === 'step' && location.turn.turn === turn
    }))
  }
  const locations = previous?.locations instanceof FixtureLocationIndex
    ? previous.locations
    : new FixtureLocationIndex()
  locations.replace(byTurn)
  store.replaceProcesses(order, locations)
  const timeline = previous !== undefined
    && previous.legacy.turnTimings === legacy.turnTimings
    && previous.legacy.turnEnds === legacy.turnEnds
    ? previous.timeline
    : { turnOrder: [...turns.keys()], turns }
  const derived = timeline.turnOrder
    .map(turn => turnNavigationItem(turn, locations, store))
    .filter((item): item is TurnNavigationItem => item !== undefined)
  const kept = previous?.navigation.items() ?? []
  const items = kept.length === derived.length
    && derived.every((item, index) => sameTurnNavigationItem(kept[index], item))
    ? kept
    : derived
  for (const data of turnData.values()) data.publish()
  store.publish()
  return {
    order,
    nodes: store,
    locations,
    navigation: { items: () => items },
    timeline,
    legacy,
  }
}
