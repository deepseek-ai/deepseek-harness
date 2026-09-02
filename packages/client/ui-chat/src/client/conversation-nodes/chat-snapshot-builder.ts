import type { Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {
  ConversationLocation, ConversationTimelineSnapshot, ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type {
  ChatLocationNodeIndex, ChatNodeProcessSource, ChatNodeSource, ChatNodeStore, ChatSnapshot,
  ChatTurnNavigationIndex, ChatTurnProcessPresentation, ConversationNode, LegacyConversationSlice,
  PartialAssistant, RunningToolCall, TurnNavigationItem,
} from '../contract/snapshot.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { sessionRecallLabels } from './event-projection.ts'
import { sameTurnNavigationItem, turnNavigationItem } from './turn-navigation.ts'
import { ChatTurnProcessProjector } from './turn-process-presentation.ts'

const EMPTY_KEYS: readonly string[] = []
const EMPTY_TURNS: readonly number[] = []
const EMPTY_ITEMS: readonly TurnNavigationItem[] = []
const EMPTY_LIST: readonly never[] = []

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
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

/* jscpd:ignore-start -- Chat Node sources keep publication state inside the keyed Chat store. */
class MutableChatSource<Value> {
  private readonly listeners = new Set<() => void>()
  private published: Value

  constructor(
    private readonly read: () => Value,
    private readonly label: string,
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
    notifySubscribers(this.listeners, this.label)
  }
}
/* jscpd:ignore-end */

class MutableChatNodeStore implements ChatNodeStore {
  private readonly byKey = new Map<string, ChatConversationViewNode>()
  private readonly turnProcesses = new ChatTurnProcessProjector()
  private readonly sources = new Map<string, MutableChatSource<ChatConversationViewNode | undefined>>()
  private readonly processSources = new Map<string, MutableChatSource<ChatTurnProcessPresentation | undefined>>()
  private readonly dirtyKeys = new Set<string>()
  private readonly dirtyProcessKeys = new Set<string>()
  private valuesCache: readonly ChatConversationViewNode[] = EMPTY_LIST
  private valuesDirty = false

  get(key: string): ChatConversationViewNode | undefined {
    return this.byKey.get(key)
  }

  source(key: string): ChatNodeSource {
    return cachedSource(this.sources, key, () => new MutableChatSource(
      () => this.get(key),
      `[ui-chat] node source ${key}`,
    ))
  }

  processSource(key: string): ChatNodeProcessSource {
    return cachedSource(this.processSources, key, () => new MutableChatSource(
      () => this.process(key),
      `[ui-chat] node process source ${key}`,
    ))
  }

  process(key: string): ChatTurnProcessPresentation | undefined {
    return this.turnProcesses.get(this.get(key) as ChatNode | undefined)
  }

  values(): readonly ChatConversationViewNode[] {
    if (this.valuesDirty) {
      this.valuesCache = [...this.byKey.values()]
      this.valuesDirty = false
    }
    return this.valuesCache
  }

  replace(nodes: readonly ChatConversationViewNode[]): void {
    const previous = new Map(this.byKey)
    this.byKey.clear()
    for (const node of nodes) {
      this.byKey.set(node.key, node)
      if (previous.get(node.key) !== node) {
        this.dirtyKeys.add(node.key)
        this.dirtyProcessKeys.add(node.key)
      }
      previous.delete(node.key)
    }
    for (const key of previous.keys()) {
      this.dirtyKeys.add(key)
      this.dirtyProcessKeys.add(key)
    }
    this.valuesCache = [...this.byKey.values()]
    this.valuesDirty = false
  }

  upsert(nodes: readonly ChatConversationViewNode[]): void {
    let changed = false
    for (const node of nodes) {
      if (this.byKey.get(node.key) === node) continue
      this.byKey.set(node.key, node)
      this.dirtyKeys.add(node.key)
      this.dirtyProcessKeys.add(node.key)
      changed = true
    }
    if (changed) this.valuesDirty = true
  }

  touchProcesses(turns: ReadonlySet<number>, locations: ChatLocationNodeIndex): void {
    for (const turn of turns) {
      for (const key of locations.getTurn(turn)) this.dirtyProcessKeys.add(key)
    }
  }

  replaceProcesses(order: readonly string[], locations: ChatLocationNodeIndex): void {
    this.touchProcesses(this.turnProcesses.replace(order, locations, this), locations)
  }

  updateProcesses(turns: ReadonlySet<number>, locations: ChatLocationNodeIndex): void {
    this.touchProcesses(this.turnProcesses.update(turns, locations, this), locations)
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

class MutableChatLocationIndex implements ChatLocationNodeIndex {
  private turns = new Map<number, readonly string[]>()
  private steps = new Map<string, readonly string[]>()

  getTurn(turn: number): readonly string[] {
    return this.turns.get(turn) ?? EMPTY_KEYS
  }

  getStep(turn: number, step: number): readonly string[] {
    return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS
  }

  rebuild(order: readonly string[], store: ChatNodeStore): void {
    const turns = new Map<number, string[]>()
    const steps = new Map<string, string[]>()
    for (const key of order) {
      const location = store.get(key)?.location
      if (location === undefined) continue
      const coordinates = locationCoordinates(location)
      if (coordinates.turn === undefined) continue
      const turnKeys = turns.get(coordinates.turn) ?? []
      turnKeys.push(key)
      turns.set(coordinates.turn, turnKeys)
      if (coordinates.step === undefined) continue
      const step = stepKey(coordinates.turn, coordinates.step)
      const stepKeys = steps.get(step) ?? []
      stepKeys.push(key)
      steps.set(step, stepKeys)
    }
    this.turns = updateIndex(this.turns, turns)
    this.steps = updateIndex(this.steps, steps)
  }

  /** Invalidate aggregate readers when member data changes without moving. */
  touch(nodes: readonly ChatConversationViewNode[]): void {
    const turns = new Set<number>()
    const steps = new Set<string>()
    for (const node of nodes) {
      const coordinates = locationCoordinates(node.location)
      if (coordinates.turn === undefined || !this.turns.get(coordinates.turn)?.includes(node.key)) continue
      turns.add(coordinates.turn)
      if (coordinates.step !== undefined) steps.add(stepKey(coordinates.turn, coordinates.step))
    }
    for (const turn of turns) {
      const keys = this.turns.get(turn)
      if (keys === undefined) continue
      this.turns.set(turn, [...keys])
    }
    for (const step of steps) {
      const keys = this.steps.get(step)
      if (keys === undefined) continue
      this.steps.set(step, [...keys])
    }
  }
}

function updateIndex<Key>(
  previous: ReadonlyMap<Key, readonly string[]>,
  nextMutable: ReadonlyMap<Key, string[]>,
): Map<Key, readonly string[]> {
  const next = new Map<Key, readonly string[]>()
  const keys = new Set([...previous.keys(), ...nextMutable.keys()])
  for (const key of keys) {
    const before = previous.get(key) ?? EMPTY_KEYS
    const candidate = nextMutable.get(key) ?? EMPTY_KEYS
    const value = sameReferences(before, candidate) ? before : candidate
    if (candidate.length > 0) next.set(key, value)
  }
  return next
}

/**
 * Loaded-Turn rail projection accumulated alongside the node store: a
 * structural change re-derives the Turn set, a content-only upsert re-derives
 * only the Turns whose nodes moved, and the published array keeps its identity
 * until an item actually changes. Renderers therefore consume final Turn data
 * instead of scanning the loaded window per frame.
 */
class MutableTurnNavigationIndex implements ChatTurnNavigationIndex {
  private current: readonly TurnNavigationItem[] = EMPTY_ITEMS
  private byTurn = new Map<number, TurnNavigationItem>()

  items(): readonly TurnNavigationItem[] {
    return this.current
  }

  /** Re-derive the whole Turn set; runs only when the loaded structure moves. */
  rebuild(
    timeline: ConversationTimelineSnapshot,
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): void {
    const next: TurnNavigationItem[] = []
    const byTurn = new Map<number, TurnNavigationItem>()
    for (const turn of timeline.turnOrder) {
      const derived = turnNavigationItem(turn, locations, nodes)
      if (derived === undefined) continue
      const previous = this.byTurn.get(turn)
      const item = previous !== undefined && sameTurnNavigationItem(previous, derived) ? previous : derived
      next.push(item)
      byTurn.set(turn, item)
    }
    this.byTurn = byTurn
    const unchanged = next.length === this.current.length
      && next.every((item, index) => item === this.current[index])
    if (!unchanged) this.current = next
  }

  /** Re-derive only the Turns a content-only upsert touched. */
  touch(
    turns: ReadonlySet<number>,
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): void {
    if (turns.size === 0) return
    const next = this.current.map((item) => {
      if (!turns.has(item.turn)) return item
      const derived = turnNavigationItem(item.turn, locations, nodes)
      if (derived === undefined || sameTurnNavigationItem(item, derived)) return item
      this.byTurn.set(item.turn, derived)
      return derived
    })
    if (next.some((item, index) => item !== this.current[index])) this.current = next
  }
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function locationCoordinates(location: ConversationLocation): { turn?: number; step?: number } {
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

function locationTurnStatus(location: ConversationLocation): string | undefined {
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.status : undefined
}

function processPresentationInputChanged(
  previous: ChatNode | undefined,
  next: ChatNode,
  structural: boolean,
): boolean {
  if (structural || previous === undefined) return true
  if (locationTurnStatus(previous.location) !== locationTurnStatus(next.location)) return true
  if (previous.kind === 'turn-process' && next.kind === 'turn-process') {
    return previous.data !== next.data
  }
  return previous.kind === 'assistant-step'
    && next.kind === 'assistant-step'
    && previous.data.step !== next.data.step
}

interface TurnProcessPresentation {
  readonly control?: ChatNode<'turn-process'>
  readonly openingHumanAnchor?: number
  readonly earliestProcessAnchor?: number
}

function turnProcessPresentations(
  nodes: readonly ChatConversationViewNode[],
): ReadonlyMap<number, TurnProcessPresentation> {
  const presentations = new Map<number, TurnProcessPresentation>()
  for (const raw of nodes) {
    const node = raw as ChatNode
    if (node.kind === 'turn-process') {
      presentations.set(node.data.turn, { ...presentations.get(node.data.turn), control: node })
    }
  }
  for (const raw of nodes) {
    const node = raw as ChatNode
    const location = node.location
    if (location.kind !== 'turn' && location.kind !== 'step') continue
    const current: TurnProcessPresentation = presentations.get(location.turn.turn) ?? {}
    if ((node.kind === 'user' || node.kind === 'steering')
      && node.anchorSeq < (current.control?.data.controlAnchorSeq ?? Number.POSITIVE_INFINITY)) {
      presentations.set(location.turn.turn, {
        ...current,
        openingHumanAnchor: Math.min(current.openingHumanAnchor ?? node.anchorSeq, node.anchorSeq),
      })
      continue
    }
    if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) continue
    presentations.set(location.turn.turn, {
      ...current,
      earliestProcessAnchor: Math.min(current.earliestProcessAnchor ?? node.anchorSeq, node.anchorSeq),
    })
  }
  return presentations
}

interface PresentationPosition {
  readonly anchor: number
  readonly rank: number
  readonly originalAnchor: number
}

function presentationPosition(
  raw: ChatConversationViewNode,
  presentations: ReadonlyMap<number, TurnProcessPresentation>,
): PresentationPosition {
  const node = raw as ChatNode
  const location = node.location
  if (location.kind !== 'turn' && location.kind !== 'step') {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
  }
  const presentation = presentations.get(location.turn.turn)
  if (presentation === undefined) {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
  }
  const openingHumanAnchor = presentation.openingHumanAnchor
  if (openingHumanAnchor !== undefined
    && node.anchorSeq < openingHumanAnchor
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) {
    return { anchor: openingHumanAnchor, rank: 2, originalAnchor: node.anchorSeq }
  }
  if (presentation.control !== undefined && node.key === presentation.control.key) {
    return openingHumanAnchor === undefined
      ? {
        anchor: presentation.earliestProcessAnchor ?? node.anchorSeq,
        rank: -1,
        originalAnchor: node.anchorSeq,
      }
      : { anchor: openingHumanAnchor, rank: 1, originalAnchor: node.anchorSeq }
  }
  return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
}

/**
 * Order visible Chat Nodes without changing existing relative order as process
 * eligibility changes. Opening human input precedes process candidates, while
 * each synthetic process control sits between them.
 * @param nodes - currently materialized Chat Nodes.
 * @returns visible Nodes in presentation order.
 */
export function orderedVisibleChatNodes(
  nodes: readonly ChatConversationViewNode[],
): ChatConversationViewNode[] {
  const visible = nodes.filter(node => node.visibility === 'visible')
  const presentations = turnProcessPresentations(visible)
  return visible.sort((left, right) => {
    const leftPosition = presentationPosition(left, presentations)
    const rightPosition = presentationPosition(right, presentations)
    return leftPosition.anchor - rightPosition.anchor
      || leftPosition.rank - rightPosition.rank
      || leftPosition.originalAnchor - rightPosition.originalAnchor
      || left.key.localeCompare(right.key)
  })
}

function referenceMessageSeq(node: ChatConversationViewNode): number | undefined {
  const candidate = node as ChatNode
  return candidate.kind === 'user' || candidate.kind === 'steering'
    ? candidate.data.seq
    : undefined
}

function followingRecall(node: ChatConversationViewNode): {
  readonly messageSeq: number
  readonly labels: readonly string[]
} | undefined {
  const candidate = node as ChatNode
  if (candidate.kind !== 'context') return undefined
  return {
    messageSeq: candidate.data.seq - 1,
    labels: sessionRecallLabels(candidate.data.source),
  }
}

function withReferenceLabels(
  node: ChatConversationViewNode,
  labels: readonly string[],
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering') return node
  const current = candidate.data.referenceLabels ?? EMPTY_KEYS
  const hasLabels = Object.hasOwn(candidate.data, 'referenceLabels')
  if (sameReferences(current, labels) && hasLabels === (labels.length > 0)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (labels.length === 0) delete data.referenceLabels
  else data.referenceLabels = labels
  return { ...candidate, data }
}

/** Associates a direct message with the sourced recall event that immediately follows it. */
class ReferenceLabelProjector {
  private readonly messagesBySeq = new Map<number, string>()
  private readonly labelsByMessageSeq = new Map<number, readonly string[]>()

  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.messagesBySeq.clear()
    this.labelsByMessageSeq.clear()
    for (const node of nodes) {
      const messageSeq = referenceMessageSeq(node)
      if (messageSeq !== undefined) this.messagesBySeq.set(messageSeq, node.key)
      const recall = followingRecall(node)
      if (recall !== undefined && recall.labels.length > 0) {
        this.labelsByMessageSeq.set(recall.messageSeq, recall.labels)
      }
    }
    return nodes.map((node) => {
      const messageSeq = referenceMessageSeq(node)
      return messageSeq === undefined
        ? node
        : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS)
    })
  }

  apply(
    upserts: readonly ChatConversationViewNode[],
    store: ChatNodeStore,
  ): readonly ChatConversationViewNode[] {
    const byKey = new Map(upserts.map(node => [node.key, node]))
    const affected = new Set<number>()
    for (const node of upserts) {
      const messageSeq = referenceMessageSeq(node)
      if (messageSeq !== undefined) {
        this.messagesBySeq.set(messageSeq, node.key)
        affected.add(messageSeq)
      }
      const recall = followingRecall(node)
      if (recall === undefined) continue
      const current = this.labelsByMessageSeq.get(recall.messageSeq)
      if (recall.labels.length === 0) this.labelsByMessageSeq.delete(recall.messageSeq)
      else {
        this.labelsByMessageSeq.set(
          recall.messageSeq,
          current !== undefined && sameReferences(current, recall.labels) ? current : recall.labels,
        )
      }
      affected.add(recall.messageSeq)
    }
    for (const messageSeq of affected) {
      const key = this.messagesBySeq.get(messageSeq)
      if (key === undefined) continue
      const node = byKey.get(key) ?? store.get(key)
      if (node === undefined) continue
      byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS))
    }
    return [...byKey.values()]
  }
}

interface LegacyContribution {
  readonly anchorSeq: number
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly running: RunningToolCall | null
}

const EMPTY_CONTRIBUTION: LegacyContribution = {
  anchorSeq: 0,
  nodes: EMPTY_LIST,
  partial: null,
  running: null,
}

function legacyContribution(raw: ChatConversationViewNode): LegacyContribution {
  const node = raw as ChatNode
  // Content-free settled Assistants remain in the finalized compatibility
  // stream so StatsLine preserves its pre-assembly step counts; hidden running
  // attempts have no final Node to contribute.
  if (raw.visibility !== 'visible' && node.kind !== 'assistant-step') return EMPTY_CONTRIBUTION
  switch (node.kind) {
    case 'user':
    case 'steering':
    case 'context':
    case 'command':
    case 'compaction':
    case 'turn-error':
    case 'turn-max-tokens':
    case 'unknown':
      return { anchorSeq: node.anchorSeq, nodes: [node.data], partial: null, running: null }
    case 'assistant-step': {
      const data = node.data
      if (data.status === 'running') {
        if (raw.visibility !== 'visible') return EMPTY_CONTRIBUTION
        return {
          anchorSeq: node.anchorSeq,
          nodes: EMPTY_LIST,
          partial: { turn: data.turn, step: data.step, blocks: data.blocks },
          running: null,
        }
      }
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.finalNode === undefined ? EMPTY_LIST : [data.finalNode],
        partial: null,
        running: null,
      }
    }
    case 'tool-call': {
      const root = node.data.root
      return isRunningTool(root)
        ? { anchorSeq: node.anchorSeq, nodes: EMPTY_LIST, partial: null, running: root }
        : { anchorSeq: node.anchorSeq, nodes: [root], partial: null, running: null }
    }
    case 'manual-compaction': {
      const data = node.data
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
        partial: null,
        running: null,
      }
    }
    case 'model-retry':
      return {
        anchorSeq: node.anchorSeq,
        nodes: node.data.attempts,
        partial: null,
        running: null,
      }
    case 'turn-tail':
    case 'system-prompt':
      // These known Chat rows intentionally make no legacy timeline contribution.
      return EMPTY_CONTRIBUTION
    default:
      return EMPTY_CONTRIBUTION
  }
}

function sameContribution(left: LegacyContribution | undefined, right: LegacyContribution): boolean {
  return left !== undefined
    && left.anchorSeq === right.anchorSeq
    && left.partial?.blocks === right.partial?.blocks
    && left.partial?.turn === right.partial?.turn
    && left.partial?.step === right.partial?.step
    && left.running === right.running
    && sameReferences(left.nodes, right.nodes)
}

/** Incremental compatibility projection for StatsLine and legacy top-level snapshot fields. */
class LegacySliceBuilder {
  private readonly contributions = new Map<string, LegacyContribution>()
  private readonly finalizedContributions = new Map<string, LegacyContribution>()
  private readonly runningContributions = new Map<string, LegacyContribution>()
  private readonly partialContributions = new Map<string, LegacyContribution>()
  private finalized: readonly ConversationNode[] = EMPTY_LIST
  private runningCalls: readonly RunningToolCall[] = EMPTY_LIST
  private partial: PartialAssistant | null = null
  private timeline: ConversationTimelineSnapshot | undefined
  private turnTimings: LegacyConversationSlice['turnTimings'] = new Map()
  private turnEnds: LegacyConversationSlice['turnEnds'] = new Map()

  replace(
    nodes: readonly ChatConversationViewNode[],
    timeline: ConversationTimelineSnapshot,
  ): LegacyConversationSlice {
    this.contributions.clear()
    this.finalizedContributions.clear()
    this.runningContributions.clear()
    this.partialContributions.clear()
    for (const node of nodes) {
      const contribution = legacyContribution(node)
      this.contributions.set(node.key, contribution)
      this.indexContribution(node.key, contribution)
    }
    this.rebuildFinalized()
    this.rebuildRunning()
    this.rebuildPartial()
    this.updateTimeline(timeline)
    return this.snapshot()
  }

  apply(
    upserts: readonly ChatConversationViewNode[],
    timeline: ConversationTimelineSnapshot,
  ): LegacyConversationSlice {
    let finalizedChanged = false
    let runningChanged = false
    let partialChanged = false
    for (const node of upserts) {
      const contribution = legacyContribution(node)
      const previous = this.contributions.get(node.key)
      if (sameContribution(previous, contribution)) continue
      finalizedChanged ||= finalizedContributionChanged(previous, contribution)
      runningChanged ||= runningContributionChanged(previous, contribution)
      partialChanged ||= partialContributionChanged(previous, contribution)
      this.contributions.set(node.key, contribution)
      this.indexContribution(node.key, contribution)
    }
    if (finalizedChanged) this.rebuildFinalized()
    if (runningChanged) this.rebuildRunning()
    if (partialChanged) this.rebuildPartial()
    this.updateTimeline(timeline)
    return this.snapshot()
  }

  private indexContribution(key: string, contribution: LegacyContribution): void {
    updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0)
    updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null)
    updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null)
  }

  private rebuildFinalized(): void {
    const finalized = [...this.finalizedContributions.values()]
      .flatMap(value => value.nodes)
      .sort((left, right) => left.seq - right.seq)
    if (!sameReferences(this.finalized, finalized)) this.finalized = finalized
  }

  private rebuildRunning(): void {
    const runningCalls = [...this.runningContributions.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
      .flatMap(value => value.running === null ? [] : [value.running])
    if (!sameReferences(this.runningCalls, runningCalls)) this.runningCalls = runningCalls
  }

  private rebuildPartial(): void {
    const partial = [...this.partialContributions.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
      .findLast(value => value.partial !== null)?.partial ?? null
    if (this.partial?.blocks !== partial?.blocks
      || this.partial?.turn !== partial?.turn
      || this.partial?.step !== partial?.step) this.partial = partial
  }

  private updateTimeline(timeline: ConversationTimelineSnapshot): void {
    if (this.timeline === timeline) return
    this.timeline = timeline
    const turnTimings = new Map<number, { startTime: number; endTime?: number }>()
    const turnEnds = new Map<number, number>()
    for (const turn of timeline.turns.values()) {
      if (turn.start !== undefined) {
        turnTimings.set(turn.turn, {
          startTime: turn.start.time,
          ...turn.end === undefined ? {} : { endTime: turn.end.time },
        })
      }
      if (turn.end !== undefined) turnEnds.set(turn.turn, turn.end.seq)
    }
    this.turnTimings = turnTimings
    this.turnEnds = turnEnds
  }

  private snapshot(): LegacyConversationSlice {
    return {
      nodes: this.finalized,
      turnTimings: this.turnTimings,
      turnEnds: this.turnEnds,
      partial: this.partial,
      runningCalls: this.runningCalls,
    }
  }
}

function updateContributionIndex(
  index: Map<string, LegacyContribution>,
  key: string,
  contribution: LegacyContribution,
  present: boolean,
): void {
  if (present) index.set(key, contribution)
  else index.delete(key)
}

function finalizedContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  const previousNodes = previous?.nodes ?? EMPTY_LIST
  return !sameReferences(previousNodes, next.nodes)
    || ((previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq)
}

function runningContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  return previous?.running !== next.running
    || ((previous.running !== null || next.running !== null)
      && previous.anchorSeq !== next.anchorSeq)
}

function partialContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  return previous?.partial?.blocks !== next.partial?.blocks
    || previous?.partial?.turn !== next.partial?.turn
    || previous?.partial?.step !== next.partial?.step
    || (((previous?.partial ?? null) !== null || next.partial !== null)
      && previous?.anchorSeq !== next.anchorSeq)
}

/** Incremental keyed Chat builder registered under the `chat` target. */
export class ChatSnapshotBuilder implements ConversationViewBuilder<ChatConversationViewNode, ChatSnapshot> {
  private readonly store = new MutableChatNodeStore()
  private readonly locations = new MutableChatLocationIndex()
  private readonly navigation = new MutableTurnNavigationIndex()
  private readonly legacy = new LegacySliceBuilder()
  private readonly referenceLabels = new ReferenceLabelProjector()
  private order: readonly string[] = EMPTY_KEYS
  /** Last published timeline: a Turn boundary can land without a new node. */
  private timeline: ConversationTimelineSnapshot | null = null
  readonly empty: ChatSnapshot

  constructor() {
    this.empty = this.snapshot({ turnOrder: EMPTY_TURNS, turns: new Map() })
  }

  replace(input: {
    readonly nodes: readonly ChatConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ChatSnapshot {
    const nodes = this.referenceLabels.replace(input.nodes)
    this.store.replace(nodes)
    this.order = orderedVisibleChatNodes(nodes).map(node => node.key)
    this.locations.rebuild(this.order, this.store)
    this.store.replaceProcesses(this.order, this.locations)
    this.navigation.rebuild(input.timeline, this.locations, this.store)
    this.timeline = input.timeline
    const snapshot = this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline))
    this.store.publish()
    return snapshot
  }

  apply(input: {
    readonly upserts: readonly ChatConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ChatSnapshot {
    const upserts = this.referenceLabels.apply(input.upserts, this.store)
    const processTurns = new Set<number>()
    let structural = false
    const contentOnly: ChatConversationViewNode[] = []
    for (const node of upserts) {
      const previous = this.store.get(node.key)
      const nodeStructural = previous === undefined
        || previous.kind !== node.kind
        || previous.anchorSeq !== node.anchorSeq
        || previous.visibility !== node.visibility
        || locationIdentity(previous.location) !== locationIdentity(node.location)
      structural ||= nodeStructural
      if (!nodeStructural) contentOnly.push(node)
      if (processPresentationInputChanged(previous as ChatNode | undefined, node as ChatNode, nodeStructural)) {
        const previousTurn = previous === undefined ? undefined : locationCoordinates(previous.location).turn
        const nextTurn = locationCoordinates(node.location).turn
        if (previousTurn !== undefined) processTurns.add(previousTurn)
        if (nextTurn !== undefined) processTurns.add(nextTurn)
      }
    }
    this.store.upsert(upserts)
    if (structural) {
      const next = orderedVisibleChatNodes(this.store.values()).map(node => node.key)
      this.order = sameReferences(this.order, next) ? this.order : next
      this.locations.rebuild(this.order, this.store)
    }
    this.locations.touch(contentOnly)
    this.store.updateProcesses(processTurns, this.locations)
    if (structural || input.timeline !== this.timeline) {
      this.navigation.rebuild(input.timeline, this.locations, this.store)
    } else {
      this.navigation.touch(turnsOf(contentOnly), this.locations, this.store)
    }
    this.timeline = input.timeline
    const snapshot = this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline))
    this.store.publish()
    return snapshot
  }

  private snapshot(
    timeline: ConversationTimelineSnapshot,
    legacy = this.legacy.replace(EMPTY_LIST, timeline),
  ): ChatSnapshot {
    return {
      order: this.order,
      nodes: this.store,
      locations: this.locations,
      navigation: this.navigation,
      timeline,
      legacy,
    }
  }
}

/** Turns owning the given nodes, for the content-only navigation update. */
function turnsOf(nodes: readonly ChatConversationViewNode[]): ReadonlySet<number> {
  const turns = new Set<number>()
  for (const node of nodes) {
    const turn = locationCoordinates(node.location).turn
    if (turn !== undefined) turns.add(turn)
  }
  return turns
}

function locationIdentity(location: ConversationLocation): string {
  const coordinates = locationCoordinates(location)
  return `${location.kind}:${coordinates.turn ?? ''}:${coordinates.step ?? ''}`
}

/** Chat target factory contributed to the Conversation view registry. */
export const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => new ChatSnapshotBuilder(),
  isActive: snapshot => snapshot.order.some(key => snapshot.nodes.get(key)?.kind !== 'command'),
}

/**
 * Register the incremental Chat target builder.
 * @param ctx - owning UI Conversation context.
 */
export function registerChatConversationView(ctx: Context): void {
  ctx.uiConversation.views.register(chatViewDefinition)
}
