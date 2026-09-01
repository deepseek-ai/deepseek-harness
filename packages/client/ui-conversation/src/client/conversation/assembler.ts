import type {
  SessionEventLikeEntry, SessionLiveEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationContextReader, ConversationLocationData, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext,
  ConversationLocationDataScope, ConversationPublication, ConversationViewBuilder,
  ConversationStartMatch,
  ConversationViewDefinition, ConversationViewNode, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
} from '../contract/conversation.ts'
import { conversationContextKey } from '../contract/conversation.ts'
import {
  ConversationLocationIndex, type ConversationLocationDataChange,
} from './location-index.ts'

interface Dependency {
  readonly kind: string
  readonly key: string | undefined
  readonly revision: number | undefined
  readonly windowGap: boolean
}

interface InternalContext {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly definition: ConversationNodeDefinition
  startSeq: number | undefined
  start: ConversationStartMatch | undefined
  matches: ConversationMatch[]
  state: unknown
  revision: number
  readonly current: Map<string, ConversationViewNode | null>
  readonly locationData: Record<ConversationLocationDataScope, ConversationLocationData | null>
  dependencies: Map<string, Dependency>
}

interface PendingMatch {
  readonly definition: ConversationNodeDefinition
  readonly id: string
  readonly match: ConversationMatch
}

interface ViewState {
  readonly target: string
  readonly definition: ConversationViewDefinition
  readonly isActive: ((snapshot: unknown) => boolean) | undefined
  builder: ConversationViewBuilder | undefined
  snapshot: unknown
}

const PUBLICATION_RANK: Record<ConversationPublication, number> = {
  none: 0,
  'animation-frame': 1,
  immediate: 2,
}

const LOCATION_DATA_SCOPES: readonly ConversationLocationDataScope[] = ['step', 'turn']

function emptyLocationData(): Record<ConversationLocationDataScope, ConversationLocationData | null> {
  return { step: null, turn: null }
}

function maximumPublication(
  left: ConversationPublication,
  right: ConversationPublication,
): ConversationPublication {
  return PUBLICATION_RANK[left] >= PUBLICATION_RANK[right] ? left : right
}

function startSeq(context: InternalContext): number | undefined {
  return context.startSeq
}

function insertionIndex(contexts: readonly InternalContext[], seq: number): number {
  let low = 0
  let high = contexts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = contexts[middle]
    if (candidate !== undefined && (candidate.startSeq as number) < seq) low = middle + 1
    else high = middle
  }
  return low
}

function contextSnapshot<State>(context: InternalContext): ConversationNodeContext<State> {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    matches: context.matches,
    start: context.start,
    state: context.state as State | undefined,
    current: context.current,
  }
}

function mergeMatches(
  key: string,
  additions: readonly ConversationMatch[],
  existing: readonly ConversationMatch[],
): ConversationMatch[] {
  const merged: ConversationMatch[] = []
  let added = 0
  let current = 0
  while (added < additions.length || current < existing.length) {
    const left = additions[added]
    const right = existing[current]
    if (left !== undefined && right !== undefined && left.event.seq === right.event.seq) {
      throw new Error(`conversation Context ${key} received duplicate Match ${left.event.seq}`)
    }
    if (right === undefined || (left !== undefined && left.event.seq < right.event.seq)) {
      merged.push(left as ConversationMatch)
      added++
    } else {
      merged.push(right)
      current++
    }
  }
  return merged
}

function conversationMatch(
  key: string,
  input: SessionEventLikeEntry,
  role: ConversationMatch['role'],
  location: ConversationMatch['location'],
): ConversationMatch {
  if (role === 'start') {
    if (input.type === 'chunks') {
      throw new Error(`conversation Context ${key} received a packed start Match`)
    }
    return { event: input.event, role, location }
  }
  return { event: input.event, role, location }
}

/** Event Registry subset consumed by a Session-owned Assembler. */
export interface ConversationEventDefinitions {
  /** @returns ordinary Definitions in registration order. */
  entries(): readonly ConversationNodeDefinition[]
  /** @returns unmatched-event fallback, when registered. */
  fallbackEntry(): ConversationNodeDefinition | undefined
}

/** View Registry subset consumed by a Session-owned Assembler. */
export interface ConversationViewDefinitions {
  /** @returns view builder factories in registration order. */
  entries(): readonly ConversationViewDefinition[]
}

/**
 * Session-owned incremental engine that assembles business Contexts from a
 * contiguous Event window and materializes registered view snapshots.
 */
export class ConversationNodeAssembler implements ConversationViewSnapshotStore {
  private readonly contexts = new Map<string, InternalContext>()
  private readonly contextsByKind = new Map<string, InternalContext[]>()
  private readonly contextsBySeq = new Map<number, Set<InternalContext>>()
  private readonly contextsByTarget = new Map<string, Set<InternalContext>>()
  private readonly inputs = new Map<number, SessionEventLikeEntry>()
  private readonly locationIndex = new ConversationLocationIndex()
  private readonly dirty = new Set<InternalContext>()
  private readonly dirtyByTarget = new Map<string, Set<InternalContext>>()
  private readonly revised = new Set<InternalContext>()
  private readonly dependents = new Map<string, Set<InternalContext>>()
  private readonly views = new Map<string, ViewState>()
  private readonly activeTargets = new Set<string>()
  private hasMore = false
  private replacePending = true
  private timelineDirty = true

  /**
   * @param eventDefinitions - live Event Definition registry.
   * @param viewDefinitions - live view builder registry.
   */
  constructor(
    private readonly eventDefinitions: ConversationEventDefinitions,
    private readonly viewDefinitions: ConversationViewDefinitions,
  ) {
    this.resetViewBuilders()
  }

  /**
   * Replace the complete loaded window after open, resync, or gap repair.
   * @param entries - complete contiguous window.
   * @param hasMore - whether older history remains outside the window.
   * @returns immediate publication request.
   */
  replaceWindow(entries: readonly SessionEventLikeEntry[], hasMore: boolean): ConversationPublication {
    this.contexts.clear()
    this.contextsByKind.clear()
    this.contextsBySeq.clear()
    this.contextsByTarget.clear()
    this.inputs.clear()
    this.dirty.clear()
    this.dirtyByTarget.clear()
    this.revised.clear()
    this.dependents.clear()
    this.hasMore = hasMore
    const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq)
    for (const entry of sorted) this.inputs.set(entry.event.seq, entry)
    this.locationIndex.rebuild(sorted)
    this.timelineDirty = true
    for (const entry of sorted) this.matchInput(entry)
    this.replayDependencies()
    this.revised.clear()
    for (const context of this.contexts.values()) this.markDirty(context)
    this.replacePending = true
    return 'immediate'
  }

  /**
   * Add one contiguous live tail event without scanning existing Contexts.
   * @param record - appended Session event entry.
   * @returns highest requested publication cadence.
   */
  append(record: SessionLiveEventEntry): ConversationPublication {
    const event = record.event
    if (this.inputs.has(event.seq)) return 'none'
    this.revised.clear()
    this.inputs.set(event.seq, record)
    let publication: ConversationPublication = 'none'
    if (isLocationBoundary(event.type)) {
      const previousTimeline = this.locationIndex.snapshot()
      const changed = this.locationIndex.appendBoundary(event)
      if (this.locationIndex.snapshot() !== previousTimeline) {
        this.timelineDirty = true
        publication = 'immediate'
      }
      this.replayContexts(this.refreshMatchLocations(changed))
      if (changed.size > 0) publication = 'immediate'
    } else {
      this.locationIndex.appendNonBoundary(event)
    }
    publication = maximumPublication(publication, this.matchInput(record))
    if (this.replayRevisedDependents()) publication = 'immediate'
    this.revised.clear()
    return publication
  }

  /**
   * Add an older page while preserving existing Context and view identities.
   * @param entries - newly loaded older Events.
   * @param hasMore - whether history still precedes the expanded window.
   * @returns highest requested publication cadence.
   */
  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): ConversationPublication {
    this.revised.clear()
    let publication: ConversationPublication = 'none'
    const previousHasMore = this.hasMore
    const fresh = entries
      .filter(entry => !this.inputs.has(entry.event.seq))
      .sort((left, right) => left.event.seq - right.event.seq)
    for (const entry of fresh) this.inputs.set(entry.event.seq, entry)
    this.hasMore = hasMore
    const previousTimeline = this.locationIndex.snapshot()
    const changedLocations = this.locationIndex.rebuild(this.sortedInputs())
    if (this.locationIndex.snapshot() !== previousTimeline) this.timelineDirty = true
    const affected = this.refreshMatchLocations(changedLocations)
    const pending = new Map<string, PendingMatch[]>()
    for (const entry of fresh) {
      publication = maximumPublication(publication, this.collectInput(entry, pending))
    }
    this.applyPendingMatches(pending, affected)
    this.replayContexts(affected)
    if ((this.revised.size > 0 || previousHasMore !== hasMore) && this.replayDependencies()) {
      publication = 'immediate'
    }
    if (changedLocations.size > 0) publication = 'immediate'
    this.revised.clear()
    return publication
  }

  /**
   * Rebuild against the current Registry set after a low-frequency plugin change.
   * @returns immediate publication request.
   */
  rebuildRegistry(): ConversationPublication {
    this.resetViewBuilders()
    return this.replaceWindow(this.sortedInputs(), this.hasMore)
  }

  /**
   * Materialize dirty Contexts and advance every active view builder.
   * @returns whether any view snapshot was rebuilt or incrementally applied.
   */
  flush(): boolean {
    if (!this.replacePending && this.dirty.size === 0 && !this.timelineDirty) return false
    if (this.replacePending) {
      this.replaceLocationData()
      let published = false
      for (const target of this.activeTargets) {
        const view = this.views.get(target)
        if (view === undefined) continue
        const builder = view.builder ?? view.definition.create()
        view.builder = builder
        view.snapshot = builder.replace({
          nodes: this.buildTargetNodes(target, this.contextsByTarget.get(target)),
          timeline: this.locationIndex.snapshot(),
        })
        published = true
      }
      this.replacePending = false
      this.dirty.clear()
      this.dirtyByTarget.clear()
      this.timelineDirty = false
      return published
    }

    let published = false
    if (this.applyDirtyLocationData()) this.timelineDirty = true
    const timelineDirty = this.timelineDirty
    for (const target of this.activeTargets) {
      const view = this.views.get(target)
      if (view === undefined) continue
      const builder = view.builder
      if (builder === undefined) continue
      const upserts = this.buildTargetUpserts(target, this.dirtyByTarget.get(target))
      if (upserts.length === 0 && !timelineDirty) continue
      view.snapshot = builder.apply({
        upserts,
        timeline: this.locationIndex.snapshot(),
      })
      published = true
    }
    this.dirty.clear()
    this.dirtyByTarget.clear()
    this.timelineDirty = false
    return published
  }

  /**
   * Add one target to the monotonic active set and materialize its current snapshot.
   * Pending Context work is flushed before the first complete replacement.
   * @param target - registered or subsequently registered view target.
   * @returns whether any active target snapshot changed.
   */
  activateTarget(target: string): boolean {
    const view = this.views.get(target)
    if (this.activeTargets.has(target)) return false
    const published = this.flush()
    this.activeTargets.add(target)
    if (view === undefined) return published
    this.replaceView(view)
    return true
  }

  /**
   * Read the latest snapshot of a registered target.
   * @param target - registered view target.
   * @returns target snapshot, or undefined before registration or activation.
   */
  snapshot(target: string): unknown {
    return this.views.get(target)?.snapshot
  }

  get<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ConversationViewSnapshotMap[Target] | undefined {
    return this.snapshot(target) as ConversationViewSnapshotMap[Target] | undefined
  }

  /**
   * Read targets whose owners classify their latest snapshot as visible activity.
   * @returns target ids contributing visible activity.
   */
  activityTargets(): ReadonlySet<string> {
    const active = new Set<string>()
    for (const target of this.activeTargets) {
      const view = this.views.get(target)
      if (view === undefined) continue
      if (view.isActive?.(view.snapshot) === true) active.add(view.target)
    }
    return active
  }

  private sortedInputs(): SessionEventLikeEntry[] {
    return [...this.inputs.values()].sort((left, right) => left.event.seq - right.event.seq)
  }

  private matchInput(input: SessionEventLikeEntry): ConversationPublication {
    return this.dispatchInput(input, (definition, id, role) =>
      this.acceptMatch(definition, id, role, input))
  }

  private collectInput(
    input: SessionEventLikeEntry,
    pending: Map<string, PendingMatch[]>,
  ): ConversationPublication {
    return this.dispatchInput(input, (definition, id, role) => {
      const key = conversationContextKey(definition.kind, id)
      const match = conversationMatch(
        key,
        input,
        role,
        this.locationIndex.locationOf(input.event),
      )
      const matches = pending.get(key) ?? []
      matches.push({ definition, id, match })
      pending.set(key, matches)
      return definition.publication?.(match) ?? 'immediate'
    })
  }

  private dispatchInput(
    input: SessionEventLikeEntry,
    accept: (
      definition: ConversationNodeDefinition,
      id: string,
      role: ConversationMatch['role'],
    ) => ConversationPublication,
  ): ConversationPublication {
    const event = input.event
    const matchedTargets = new Set<string>()
    let publication: ConversationPublication = 'none'
    for (const definition of this.eventDefinitions.entries()) {
      const result = definition.match(event)
      if (result === null) continue
      if (definition.target !== undefined) matchedTargets.add(definition.target)
      publication = maximumPublication(publication, accept(definition, result.id, result.role))
    }
    const fallback = this.eventDefinitions.fallbackEntry()
    const target = fallback?.target
    if (fallback !== undefined && target !== undefined && !matchedTargets.has(target)) {
      const result = fallback.match(event)
      if (result !== null) {
        publication = maximumPublication(publication, accept(fallback, result.id, result.role))
      }
    }
    return publication
  }

  private createContext(
    definition: ConversationNodeDefinition,
    id: string,
    key: string,
  ): InternalContext {
    const context: InternalContext = {
      key,
      kind: definition.kind,
      id,
      definition,
      startSeq: undefined,
      start: undefined,
      matches: [],
      state: undefined,
      revision: 0,
      current: new Map(),
      locationData: emptyLocationData(),
      dependencies: new Map(),
    }
    this.contexts.set(key, context)
    this.indexTargetContext(context)
    return context
  }

  private acceptMatch(
    definition: ConversationNodeDefinition,
    id: string,
    role: ConversationMatch['role'],
    input: SessionEventLikeEntry,
  ): ConversationPublication {
    const key = conversationContextKey(definition.kind, id)
    let context = this.contexts.get(key)
    if (role === 'start' && context?.start !== undefined) {
      throw new Error(`conversation Context ${key} received more than one start Match`)
    }
    context ??= this.createContext(definition, id, key)
    const match = conversationMatch(
      key,
      input,
      role,
      this.locationIndex.locationOf(input.event),
    )
    const previous = context.matches.at(-1)
    if (previous !== undefined && previous.event.seq >= input.event.seq) {
      throw new Error(`conversation Context ${key} received non-appended Match ${input.event.seq}`)
    }
    if (role === 'start' && context.matches.length > 0) {
      throw new Error(`conversation Context ${key} received an update before its start Match`)
    }
    context.matches.push(match)
    if (match.role === 'start') {
      context.startSeq = input.event.seq
      context.start = match
      this.indexStartedContext(context)
    }
    const owners = this.contextsBySeq.get(input.event.seq) ?? new Set<InternalContext>()
    owners.add(context)
    this.contextsBySeq.set(input.event.seq, owners)

    if (match.role === 'start') {
      this.replayContext(context)
    } else if (context.state !== undefined) {
      const typed = contextSnapshot(context) as ConversationNodeContext & { readonly state: unknown }
      context.state = requireState(definition, 'update', definition.update(typed, match))
      context.revision++
      this.revised.add(context)
    }
    this.markDirty(context)
    return definition.publication?.(match) ?? 'immediate'
  }

  private applyPendingMatches(
    pending: ReadonlyMap<string, readonly PendingMatch[]>,
    affected: Set<InternalContext>,
  ): void {
    const startsByKind = new Map<string, InternalContext[]>()
    for (const [key, entries] of pending) {
      const first = entries[0]
      if (first === undefined) continue
      let context = this.contexts.get(key)
      context ??= this.createContext(first.definition, first.id, key)
      let discoveredStart: ConversationStartMatch | undefined
      const additions = entries
        .map((entry) => {
          if (entry.definition !== context.definition || entry.id !== context.id) {
            throw new Error(`conversation Context ${key} received inconsistent Definition identity`)
          }
          if (entry.match.role === 'start') {
            if (discoveredStart !== undefined || context.start !== undefined) {
              throw new Error(`conversation Context ${key} received more than one start Match`)
            }
            discoveredStart = entry.match
          }
          const owners = this.contextsBySeq.get(entry.match.event.seq) ?? new Set<InternalContext>()
          owners.add(context)
          this.contextsBySeq.set(entry.match.event.seq, owners)
          return entry.match
        })
        .sort((left, right) => left.event.seq - right.event.seq)
      context.matches = mergeMatches(context.key, additions, context.matches)
      if (discoveredStart !== undefined) {
        context.start = discoveredStart
        context.startSeq = discoveredStart.event.seq
        const starts = startsByKind.get(context.kind) ?? []
        starts.push(context)
        startsByKind.set(context.kind, starts)
      }
      if (context.start !== undefined && context.matches[0] !== context.start) {
        throw new Error(`conversation Context ${context.key} received an update before its start Match`)
      }
      affected.add(context)
      this.markDirty(context)
    }
    for (const [kind, contexts] of startsByKind) this.indexStartedContexts(kind, contexts)
  }

  private replayContexts(contexts: ReadonlySet<InternalContext>): void {
    const ordered = [...contexts].sort((left, right) =>
      (left.startSeq ?? Number.POSITIVE_INFINITY) - (right.startSeq ?? Number.POSITIVE_INFINITY))
    for (const context of ordered) {
      if (context.start === undefined) {
        context.state = undefined
        this.markDirty(context)
        continue
      }
      this.replayContext(context)
    }
  }

  private replayContext(context: InternalContext): void {
    const start = context.start
    if (start === undefined) {
      context.state = undefined
      return
    }
    if (context.matches[0] !== start) {
      throw new Error(`conversation Context ${context.key} received an update before its start Match`)
    }
    const dependencies = new Map<string, Dependency>()
    const reader = this.readerFor(start.event.seq, dependencies)
    context.state = undefined
    context.state = requireState(
      context.definition,
      'start',
      context.definition.start(contextSnapshot(context), start, reader),
    )
    this.replaceDependencies(context, dependencies)
    for (let index = 1; index < context.matches.length; index++) {
      const match = context.matches[index]
      if (match === undefined || match.role !== 'update') continue
      const typed = contextSnapshot(context) as ConversationNodeContext & { readonly state: unknown }
      context.state = requireState(
        context.definition,
        'update',
        context.definition.update(typed, match),
      )
    }
    context.revision++
    this.revised.add(context)
    this.markDirty(context)
  }

  private indexTargetContext(context: InternalContext): void {
    const target = context.definition.target
    if (target === undefined) return
    const contexts = this.contextsByTarget.get(target) ?? new Set<InternalContext>()
    contexts.add(context)
    this.contextsByTarget.set(target, contexts)
  }

  private markDirty(context: InternalContext): void {
    this.dirty.add(context)
    const target = context.definition.target
    if (target === undefined || !this.activeTargets.has(target)) return
    const contexts = this.dirtyByTarget.get(target) ?? new Set<InternalContext>()
    contexts.add(context)
    this.dirtyByTarget.set(target, contexts)
  }

  private replaceDependencies(context: InternalContext, dependencies: Map<string, Dependency>): void {
    for (const dependency of context.dependencies.values()) {
      if (dependency.key === undefined) continue
      const current = this.dependents.get(dependency.key)
      current?.delete(context)
      if (current?.size === 0) this.dependents.delete(dependency.key)
    }
    context.dependencies = dependencies
    for (const dependency of dependencies.values()) {
      if (dependency.key === undefined) continue
      const current = this.dependents.get(dependency.key) ?? new Set()
      current.add(context)
      this.dependents.set(dependency.key, current)
    }
  }

  private replayRevisedDependents(): boolean {
    const pending = [...this.revised]
    const affected = new Set<InternalContext>()
    for (let index = 0; index < pending.length; index++) {
      const dependency = pending[index]
      if (dependency === undefined) continue
      for (const dependent of this.dependents.get(dependency.key) ?? []) {
        if (affected.has(dependent)) continue
        affected.add(dependent)
        pending.push(dependent)
      }
    }
    this.replayContexts(affected)
    return affected.size > 0
  }

  private readerFor(
    beforeSeq: number,
    dependencies: Map<string, Dependency>,
  ): ConversationContextReader {
    return {
      previous: <State>(kind: string): ConversationPreviousContext<State> | undefined => {
        const predecessor = this.previousContext(kind, beforeSeq)
        dependencies.set(kind, {
          kind,
          key: predecessor?.key,
          revision: predecessor?.revision,
          windowGap: predecessor === undefined && this.hasMore,
        })
        if (predecessor?.state === undefined) return undefined
        const seq = startSeq(predecessor)
        if (seq === undefined) return undefined
        return {
          key: predecessor.key,
          kind: predecessor.kind,
          id: predecessor.id,
          startSeq: seq,
          state: predecessor.state as Readonly<State>,
          matches: predecessor.matches,
        }
      },
    }
  }

  private previousContext(kind: string, beforeSeq: number): InternalContext | undefined {
    const candidates = this.contextsByKind.get(kind) ?? []
    const indexBefore = insertionIndex(candidates, beforeSeq)
    for (let index = indexBefore - 1; index >= 0; index--) {
      const candidate = candidates[index]
      if (candidate?.state !== undefined) return candidate
    }
    return undefined
  }

  /** Insert one newly discovered start into its Definition's ordered predecessor index. */
  private indexStartedContext(context: InternalContext): void {
    const seq = context.startSeq
    if (seq === undefined) return
    const candidates = this.contextsByKind.get(context.kind) ?? []
    const previous = candidates.at(-1)
    if (previous === undefined || (previous.startSeq as number) < seq) candidates.push(context)
    else candidates.splice(insertionIndex(candidates, seq), 0, context)
    this.contextsByKind.set(context.kind, candidates)
  }

  private indexStartedContexts(kind: string, additions: readonly InternalContext[]): void {
    if (additions.length === 0) return
    const sorted = [...additions].sort((left, right) =>
      (left.startSeq as number) - (right.startSeq as number))
    const existing = this.contextsByKind.get(kind) ?? []
    const merged: InternalContext[] = []
    let before = 0
    let added = 0
    while (before < existing.length || added < sorted.length) {
      const left = existing[before]
      const right = sorted[added]
      if (right === undefined || (left !== undefined && (left.startSeq as number) < (right.startSeq as number))) {
        merged.push(left as InternalContext)
        before++
      } else {
        merged.push(right)
        added++
      }
    }
    this.contextsByKind.set(kind, merged)
  }

  private replayDependencies(): boolean {
    let replayed = false
    const ordered = [...this.contexts.values()]
      .filter(context => startSeq(context) !== undefined)
      .sort((left, right) => (startSeq(left) as number) - (startSeq(right) as number))
    for (const context of ordered) {
      if (context.state === undefined || context.dependencies.size === 0) continue
      const before = startSeq(context)
      if (before === undefined) continue
      let changed = false
      for (const dependency of context.dependencies.values()) {
        const current = this.previousContext(dependency.kind, before)
        const windowGap = current === undefined && this.hasMore
        if (current?.key !== dependency.key
          || current?.revision !== dependency.revision
          || windowGap !== dependency.windowGap) {
          changed = true
          break
        }
      }
      if (changed) {
        this.replayContext(context)
        replayed = true
      }
    }
    return replayed
  }

  private refreshMatchLocations(changedSeqs: ReadonlySet<number>): Set<InternalContext> {
    const affected = new Set<InternalContext>()
    if (changedSeqs.size === 0) return affected
    for (const seq of changedSeqs) {
      for (const context of this.contextsBySeq.get(seq) ?? []) affected.add(context)
    }
    for (const context of affected) {
      let start = context.start
      const matches = context.matches.map((match): ConversationMatch => {
        if (!changedSeqs.has(match.event.seq)) return match
        if (match.role === 'start') {
          const refreshed: ConversationStartMatch = {
            ...match,
            location: this.locationIndex.locationOf(match.event),
          }
          if (match === start) start = refreshed
          return refreshed
        }
        return { ...match, location: this.locationIndex.locationOf(match.event) }
      })
      context.matches = matches
      context.start = start
    }
    return affected
  }

  private buildNode(context: InternalContext, target: string): ConversationViewNode | null {
    if (context.definition.target !== target || context.definition.buildViewNode === undefined) return null
    const node = context.definition.buildViewNode(contextSnapshot(context))
    if (node === null) return null
    if (node.key !== context.key) {
      throw new Error(`conversation Definition "${context.kind}" returned unstable key "${node.key}"; expected "${context.key}"`)
    }
    if (node.target !== target) {
      throw new Error(`conversation Definition "${context.kind}" returned target "${node.target}" while building "${target}"`)
    }
    return node
  }

  private replaceView(view: ViewState): void {
    const builder = view.builder ?? view.definition.create()
    view.builder = builder
    view.snapshot = builder.replace({
      nodes: this.buildTargetNodes(view.target, this.contextsByTarget.get(view.target)),
      timeline: this.locationIndex.snapshot(),
    })
  }

  private buildTargetNodes(
    target: string,
    contexts: Iterable<InternalContext> | undefined,
  ): ConversationViewNode[] {
    const nodes: ConversationViewNode[] = []
    for (const context of contexts ?? []) {
      const node = this.buildNode(context, target)
      context.current.set(target, node)
      if (node !== null) nodes.push(node)
    }
    return nodes
  }

  private buildTargetUpserts(
    target: string,
    contexts: Iterable<InternalContext> | undefined,
  ): ConversationViewNode[] {
    const upserts: ConversationViewNode[] = []
    for (const context of contexts ?? []) {
      const previous = context.current.get(target) ?? null
      const node = this.buildNode(context, target)
      if (node === null && previous !== null) {
        throw new Error(
          `conversation Definition "${context.kind}" withdrew materialized target "${target}"; return the same key with hidden visibility instead`,
        )
      }
      context.current.set(target, node)
      if (node !== null) upserts.push(node)
    }
    return upserts
  }

  private buildLocationData(
    context: InternalContext,
    scope: ConversationLocationDataScope,
  ): ConversationLocationData | null {
    if (context.definition.buildLocationData === undefined) return null
    const data = context.definition.buildLocationData(contextSnapshot(context), scope)
    if (data === null) return null
    if (data.kind !== scope) {
      throw new Error(
        `conversation Definition "${context.kind}" published ${data.kind} data through its ${scope} scope`,
      )
    }
    if (data.key !== context.kind) {
      throw new Error(
        `conversation Definition "${context.kind}" published Location data key "${data.key}"; expected its owned kind`,
      )
    }
    if (!Number.isSafeInteger(data.turn) || data.turn < 0) {
      throw new Error(`conversation Definition "${context.kind}" published invalid turn ${data.turn}`)
    }
    if (data.kind === 'step' && (!Number.isSafeInteger(data.step) || (data.step as number) < 0)) {
      throw new Error(`conversation Definition "${context.kind}" published invalid step ${String(data.step)}`)
    }
    return data
  }

  private replaceLocationData(): void {
    const entries: { owner: string; data: ConversationLocationData }[] = []
    for (const scope of LOCATION_DATA_SCOPES) {
      for (const context of this.contexts.values()) {
        const data = this.buildLocationData(context, scope)
        context.locationData[scope] = data
        if (data !== null) entries.push({ owner: context.key, data })
      }
      // Turn publishers may read Step data from this same flush, so each phase
      // installs the cumulative replacement before the next phase builds.
      this.locationIndex.replaceData(entries)
    }
  }

  private applyDirtyLocationData(): boolean {
    let changed = false
    for (const scope of LOCATION_DATA_SCOPES) {
      const changes: ConversationLocationDataChange[] = []
      for (const context of this.dirty) {
        const previous = context.locationData[scope]
        const next = this.buildLocationData(context, scope)
        context.locationData[scope] = next
        if (previous !== next) changes.push({ owner: context.key, previous, next })
      }
      changed = this.locationIndex.applyData(changes) || changed
    }
    return changed
  }

  private resetViewBuilders(): void {
    this.views.clear()
    for (const definition of this.viewDefinitions.entries()) {
      const view: ViewState = {
        target: definition.target,
        definition,
        isActive: definition.isActive === undefined
          ? undefined
          : snapshot => definition.isActive?.(snapshot) === true,
        builder: undefined,
        snapshot: undefined,
      }
      this.views.set(definition.target, view)
    }
    this.replacePending = true
  }
}

function isLocationBoundary(type: string): boolean {
  return type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end'
}

function requireState(
  definition: ConversationNodeDefinition,
  phase: 'start' | 'update',
  state: unknown,
): unknown {
  if (state === undefined) {
    throw new Error(`conversation Definition "${definition.kind}" returned undefined from ${phase}()`)
  }
  return state
}
