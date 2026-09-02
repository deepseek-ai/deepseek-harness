import {
  type SessionEventLike, type SessionEventLikeEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationLocation, ConversationLocationData,
  ConversationLocationDataSource, ConversationLocationDataStore, ConversationStepDataMap,
  ConversationTimelineSnapshot, ConversationTurnDataMap, StepLocation, TurnLocation,
} from '../contract/conversation.ts'

interface OwnedLocationData {
  readonly owner: string
  readonly value: unknown
}

/** One Context's previous and next Location-data publication. */
export interface ConversationLocationDataChange {
  readonly owner: string
  readonly previous: ConversationLocationData | null
  readonly next: ConversationLocationData | null
}

class MutableLocationDataSource implements ConversationLocationDataSource<unknown> {
  private readonly listeners = new Set<() => void>()
  private published: unknown

  constructor(
    private readonly store: MutableLocationDataStore,
    private readonly key: string,
  ) {
    this.published = store.get(key)
  }

  readonly getSnapshot = (): unknown => this.store.get(this.key)

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(): void {
    const next = this.getSnapshot()
    if (this.published === next) return
    this.published = next
    notifySubscribers(this.listeners, `[ui-conversation] Location data ${this.key}`)
  }
}

class MutableLocationDataStore {
  private entries = new Map<string, OwnedLocationData>()
  private readonly sources = new Map<string, MutableLocationDataSource>()
  private readonly dirtyKeys = new Set<string>()

  constructor(private readonly markDirty: (store: MutableLocationDataStore) => void) {}

  get(key: string): unknown {
    return this.entries.get(key)?.value
  }

  source(key: string): ConversationLocationDataSource<unknown> {
    let source = this.sources.get(key)
    if (source === undefined) {
      source = new MutableLocationDataSource(this, key)
      this.sources.set(key, source)
    }
    return source
  }

  remove(owner: string, key: string): boolean {
    const current = this.entries.get(key)
    if (current?.owner !== owner) return false
    this.entries.delete(key)
    this.changed(key)
    return true
  }

  set(owner: string, key: string, value: unknown): boolean {
    const current = this.entries.get(key)
    if (current !== undefined && current.owner !== owner) {
      throw new Error(`conversation Location data "${key}" is already owned by ${current.owner}`)
    }
    if (current?.value === value) return false
    this.entries.set(key, { owner, value })
    this.changed(key)
    return true
  }

  replace(entries: ReadonlyMap<string, OwnedLocationData>): boolean {
    const changedKeys: string[] = []
    for (const key of new Set([...this.entries.keys(), ...entries.keys()])) {
      const current = this.entries.get(key)
      const next = entries.get(key)
      if (current?.owner !== next?.owner || current?.value !== next?.value) changedKeys.push(key)
    }
    if (changedKeys.length === 0) return false
    this.entries = new Map(entries)
    for (const key of changedKeys) this.changed(key)
    return true
  }

  publish(): void {
    const dirty = [...this.dirtyKeys]
    this.dirtyKeys.clear()
    for (const key of dirty) this.sources.get(key)?.publish()
  }

  private changed(key: string): void {
    this.dirtyKeys.add(key)
    this.markDirty(this)
  }
}

interface Coordinates {
  readonly turn?: number
  readonly step?: number
  readonly session?: true
}

interface StepDraft {
  readonly turn: number
  readonly step: number
  firstSeq: number
  start?: SessionEvent<'step/start'>
  end?: SessionEvent<'step/end'>
}

interface TurnDraft {
  readonly turn: number
  firstSeq: number
  start?: SessionEvent<'turn/start'>
  end?: SessionEvent<'turn/end'>
  readonly steps: Map<number, StepDraft>
}

const SESSION_LOCATION = { kind: 'session' } as const
const UNRESOLVED_LOCATION = { kind: 'unresolved' } as const

function payloadCoordinates(event: SessionEventLike): Coordinates {
  const data = event.data as unknown as { turn?: unknown; step?: unknown }
  if (data.turn === null) return { session: true }
  const turn = Number.isSafeInteger(data.turn) && (data.turn as number) >= 0
    ? data.turn as number
    : undefined
  const step = Number.isSafeInteger(data.step) && (data.step as number) >= 0
    ? data.step as number
    : undefined
  return { ...turn === undefined ? {} : { turn }, ...step === undefined ? {} : { step } }
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStep(left: StepLocation | undefined, right: StepLocation): boolean {
  return left !== undefined
    && left.start === right.start && left.end === right.end && left.status === right.status
    && left.data === right.data
}

function sameTurn(left: TurnLocation | undefined, right: TurnLocation): boolean {
  return left !== undefined
    && left.start === right.start && left.end === right.end && left.status === right.status
    && left.data === right.data && sameReferences(left.steps, right.steps)
}

function sameLocation(left: ConversationLocation | undefined, right: ConversationLocation | undefined): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return left === right
  if (left.kind === 'session' || left.kind === 'unresolved') return true
  if (right.kind === 'session' || right.kind === 'unresolved') return false
  if (left.kind === 'turn' || right.kind === 'turn') {
    return left.kind === 'turn' && right.kind === 'turn' && left.turn === right.turn
  }
  return left.turn === right.turn && left.step === right.step
}

/** Session-owned Turn/Step timeline and event-to-Location index. */
export class ConversationLocationIndex {
  private coordinates = new Map<number, Coordinates>()
  private locations = new Map<number, ConversationLocation>()
  private seqsByTurn = new Map<number, Set<number>>()
  private timeline: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }
  private readonly turnDataStores = new Map<number, MutableLocationDataStore>()
  private readonly stepDataStores = new Map<string, MutableLocationDataStore>()
  private readonly dirtyDataStores = new Set<MutableLocationDataStore>()
  private currentTurn: number | undefined
  private currentStep: number | undefined

  /**
   * Return the current reference-stable timeline.
   * @returns current timeline snapshot.
   */
  snapshot(): ConversationTimelineSnapshot {
    return this.timeline
  }

  /**
   * Replace all Definition-owned Location values while preserving reader identities.
   * @param entries - complete current set of Definition-owned Location values.
   * @returns whether any published Location data changed.
   */
  replaceData(entries: readonly { readonly owner: string; readonly data: ConversationLocationData }[]): boolean {
    const turns = new Map<number, Map<string, OwnedLocationData>>()
    const steps = new Map<string, Map<string, OwnedLocationData>>()
    for (const { owner, data } of entries) {
      const values = data.kind === 'turn'
        ? turns.get(data.turn) ?? new Map<string, OwnedLocationData>()
        : steps.get(stepDataKey(data.turn, requireStep(data))) ?? new Map<string, OwnedLocationData>()
      const current = values.get(data.key)
      if (current !== undefined && current.owner !== owner) {
        throw new Error(`conversation Location data "${data.key}" is already owned by ${current.owner}`)
      }
      values.set(data.key, { owner, value: data.value })
      if (data.kind === 'turn') turns.set(data.turn, values)
      else steps.set(stepDataKey(data.turn, requireStep(data)), values)
    }
    let changed = false
    for (const turn of new Set([...this.turnDataStores.keys(), ...turns.keys()])) {
      changed = this.mutableTurnData(turn).replace(turns.get(turn) ?? new Map()) || changed
    }
    for (const step of new Set([...this.stepDataStores.keys(), ...steps.keys()])) {
      changed = this.mutableStepData(step).replace(steps.get(step) ?? new Map()) || changed
    }
    return changed
  }

  /**
   * Apply changed Context publications without rebuilding Turn/Step membership.
   * @param changes - incremental removals and replacements from published Contexts.
   * @returns whether any published Location data changed.
   */
  applyData(changes: readonly ConversationLocationDataChange[]): boolean {
    let changed = false
    for (const change of changes) {
      const previous = change.previous
      if (previous === null) continue
      changed = this.storeFor(previous).remove(change.owner, previous.key) || changed
    }
    for (const change of changes) {
      const next = change.next
      if (next === null) continue
      changed = this.storeFor(next).set(change.owner, next.key, next.value) || changed
    }
    return changed
  }

  /** Publish committed Location-data changes to their keyed sources. */
  publishData(): void {
    const dirty = [...this.dirtyDataStores]
    this.dirtyDataStores.clear()
    for (const store of dirty) store.publish()
  }

  /**
   * Resolve the latest Location for one event.
   * @param event - event already ingested into this index.
   * @returns current Location, falling back to session when it has no Turn/Step affinity.
   */
  locationOf(event: SessionEventLike): ConversationLocation {
    return this.locations.get(event.seq) ?? SESSION_LOCATION
  }

  /**
   * Rebuild timeline facts after replace/prepend or a boundary append.
   * @param entries - complete current window in ascending seq order.
   * @returns seqs whose resolved Location changed.
   */
  rebuild(entries: readonly SessionEventLikeEntry[]): ReadonlySet<number> {
    const previousLocations = this.locations
    const turns = new Map<number, TurnDraft>()
    const coordinates = new Map<number, Coordinates>()
    let currentTurn: number | undefined
    let currentStep: number | undefined

    const turnDraft = (turn: number, seq: number): TurnDraft => {
      let draft = turns.get(turn)
      if (draft === undefined) {
        draft = { turn, firstSeq: seq, steps: new Map() }
        turns.set(turn, draft)
      } else {
        draft.firstSeq = Math.min(draft.firstSeq, seq)
      }
      return draft
    }
    const stepDraft = (turn: number, step: number, seq: number): StepDraft => {
      const owner = turnDraft(turn, seq)
      let draft = owner.steps.get(step)
      if (draft === undefined) {
        draft = { turn, step, firstSeq: seq }
        owner.steps.set(step, draft)
      } else {
        draft.firstSeq = Math.min(draft.firstSeq, seq)
      }
      return draft
    }

    for (const { event } of entries) {
      const explicit = payloadCoordinates(event)
      if (event.type === 'turn/start') {
        currentTurn = event.data.turn
        currentStep = undefined
      }
      if (event.type === 'step/start') {
        currentTurn = event.data.turn
        currentStep = event.data.step
      }
      if (explicit.session !== true && explicit.turn !== undefined) {
        if (currentTurn !== explicit.turn) currentStep = undefined
        currentTurn = explicit.turn
        if (explicit.step !== undefined) currentStep = explicit.step
      }
      const turn = explicit.session === true ? undefined : explicit.turn ?? currentTurn
      const step = explicit.session === true || event.type === 'turn/start' || event.type === 'turn/end'
        ? undefined
        : explicit.step ?? (turn === currentTurn ? currentStep : undefined)
      coordinates.set(event.seq, {
        ...turn === undefined ? {} : { turn },
        ...turn === undefined || step === undefined ? {} : { step },
      })
      if (turn !== undefined) turnDraft(turn, event.seq)
      if (turn !== undefined && step !== undefined) stepDraft(turn, step, event.seq)

      if (event.type === 'turn/start') {
        turnDraft(event.data.turn, event.seq).start = event
      } else if (event.type === 'turn/end') {
        turnDraft(event.data.turn, event.seq).end = event
      } else if (event.type === 'step/start') {
        stepDraft(event.data.turn, event.data.step, event.seq).start = event
      } else if (event.type === 'step/end') {
        stepDraft(event.data.turn, event.data.step, event.seq).end = event
      }

      if (event.type === 'step/end' && currentTurn === event.data.turn && currentStep === event.data.step) {
        currentStep = undefined
      }
      if (event.type === 'turn/end' && currentTurn === event.data.turn) {
        currentTurn = undefined
        currentStep = undefined
      }
    }

    const previousTurns = this.timeline.turns
    const nextTurns = new Map<number, TurnLocation>()
    const orderedDrafts = [...turns.values()].sort((left, right) => left.firstSeq - right.firstSeq)
    for (const draft of orderedDrafts) {
      const previousTurn = previousTurns.get(draft.turn)
      const previousSteps = new Map(previousTurn?.steps.map(step => [step.step, step]) ?? [])
      const steps = [...draft.steps.values()]
        .sort((left, right) => left.firstSeq - right.firstSeq)
        .map((candidate): StepLocation => {
          const value: StepLocation = {
            turn: candidate.turn,
            step: candidate.step,
            start: candidate.start,
            end: candidate.end,
            status: candidate.end !== undefined
              ? 'closed'
              : candidate.start === undefined ? 'unknown' : 'open',
            data: this.stepData(candidate.turn, candidate.step),
          }
          const previous = previousSteps.get(candidate.step)
          return sameStep(previous, value) ? previous as StepLocation : value
        })
      const value: TurnLocation = {
        turn: draft.turn,
        start: draft.start,
        end: draft.end,
        status: draft.end !== undefined ? 'closed' : draft.start === undefined ? 'unknown' : 'open',
        steps,
        data: this.turnData(draft.turn),
      }
      nextTurns.set(draft.turn, sameTurn(previousTurn, value) ? previousTurn as TurnLocation : value)
    }

    const nextOrder = orderedDrafts.map(draft => draft.turn)
    const turnOrder = this.timeline.turnOrder.length === nextOrder.length
      && this.timeline.turnOrder.every((turn, index) => turn === nextOrder[index])
      ? this.timeline.turnOrder
      : nextOrder
    let sameMap = previousTurns.size === nextTurns.size
    if (sameMap) {
      for (const [turn, value] of nextTurns) {
        if (previousTurns.get(turn) !== value) {
          sameMap = false
          break
        }
      }
    }
    this.timeline = sameMap && turnOrder === this.timeline.turnOrder
      ? this.timeline
      : { turnOrder, turns: nextTurns }
    this.coordinates = coordinates
    this.locations = new Map()
    this.seqsByTurn = new Map()
    for (const { event } of entries) {
      const coordinates = this.coordinates.get(event.seq)
      if (coordinates?.turn !== undefined) this.indexTurnSeq(coordinates.turn, event.seq)
      this.locations.set(event.seq, this.resolve(event.seq))
    }
    this.currentTurn = currentTurn
    this.currentStep = currentStep

    const changed = new Set<number>()
    for (const { event } of entries) {
      if (!sameLocation(previousLocations.get(event.seq), this.locations.get(event.seq))) {
        changed.add(event.seq)
      }
    }
    return changed
  }

  /**
   * Append one Turn/Step boundary while revisiting only the owning Turn.
   * @param event - contiguous tail boundary event.
   * @returns seqs whose immutable Location reference changed.
   */
  appendBoundary(event: SessionEvent): ReadonlySet<number> {
    if (event.type !== 'turn/start' && event.type !== 'turn/end'
      && event.type !== 'step/start' && event.type !== 'step/end') {
      throw new Error(`conversation Location boundary expected, received ${event.type}`)
    }

    const explicit = payloadCoordinates(event)
    if (event.type === 'turn/start') {
      this.currentTurn = event.data.turn
      this.currentStep = undefined
    } else if (event.type === 'step/start') {
      this.currentTurn = event.data.turn
      this.currentStep = event.data.step
    }
    if (explicit.turn !== undefined) {
      if (this.currentTurn !== explicit.turn) this.currentStep = undefined
      this.currentTurn = explicit.turn
      if (explicit.step !== undefined) this.currentStep = explicit.step
    }
    const turnNumber = explicit.turn ?? this.currentTurn
    if (turnNumber === undefined) throw new Error(`conversation boundary ${event.type} has no turn`)
    const stepNumber = event.type === 'turn/start' || event.type === 'turn/end'
      ? undefined
      : explicit.step ?? (turnNumber === this.currentTurn ? this.currentStep : undefined)
    this.coordinates.set(event.seq, {
      turn: turnNumber,
      ...stepNumber === undefined ? {} : { step: stepNumber },
    })
    this.indexTurnSeq(turnNumber, event.seq)

    const previousTurn = this.timeline.turns.get(turnNumber)
    let steps = previousTurn?.steps ?? []
    if (event.type === 'step/start' || event.type === 'step/end') {
      const number = event.data.step
      const previousStep = steps.find(candidate => candidate.step === number)
      const candidate: StepLocation = {
        turn: turnNumber,
        step: number,
        start: event.type === 'step/start' ? event : previousStep?.start,
        end: event.type === 'step/end' ? event : previousStep?.end,
        status: event.type === 'step/end' || previousStep?.end !== undefined ? 'closed' : 'open',
        data: this.stepData(turnNumber, number),
      }
      const nextStep = sameStep(previousStep, candidate) ? previousStep as StepLocation : candidate
      const index = steps.findIndex(step => step.step === number)
      steps = index < 0
        ? [...steps, nextStep]
        : steps.map((step, at) => at === index ? nextStep : step)
    }
    const candidate: TurnLocation = {
      turn: turnNumber,
      start: event.type === 'turn/start' ? event : previousTurn?.start,
      end: event.type === 'turn/end' ? event : previousTurn?.end,
      status: event.type === 'turn/end' || previousTurn?.end !== undefined
        ? 'closed'
        : event.type === 'turn/start' || previousTurn?.start !== undefined ? 'open' : 'unknown',
      steps,
      data: this.turnData(turnNumber),
    }
    const turn = sameTurn(previousTurn, candidate) ? previousTurn as TurnLocation : candidate
    const turns = new Map(this.timeline.turns)
    turns.set(turnNumber, turn)
    const turnOrder = previousTurn === undefined
      ? [...this.timeline.turnOrder, turnNumber]
      : this.timeline.turnOrder
    this.timeline = { turnOrder, turns }

    const changed = new Set<number>()
    for (const seq of this.seqsByTurn.get(turnNumber) ?? []) {
      const previous = this.locations.get(seq)
      const next = this.resolve(seq)
      this.locations.set(seq, next)
      if (!sameLocation(previous, next)) changed.add(seq)
    }

    if (event.type === 'step/end' && this.currentTurn === event.data.turn && this.currentStep === event.data.step) {
      this.currentStep = undefined
    }
    if (event.type === 'turn/end' && this.currentTurn === event.data.turn) {
      this.currentTurn = undefined
      this.currentStep = undefined
    }
    return changed
  }

  /**
   * Index one non-boundary tail event without rescanning the window.
   * @param event - contiguous appended event.
   */
  appendNonBoundary(event: SessionEvent): void {
    const explicit = payloadCoordinates(event)
    if (explicit.session === true) {
      this.coordinates.set(event.seq, {})
      this.locations.set(event.seq, SESSION_LOCATION)
      return
    }
    if (explicit.turn !== undefined) {
      if (this.currentTurn !== explicit.turn) this.currentStep = undefined
      this.currentTurn = explicit.turn
      if (explicit.step !== undefined) this.currentStep = explicit.step
    }
    const turn = explicit.turn ?? this.currentTurn
    const step = explicit.step ?? (turn === this.currentTurn ? this.currentStep : undefined)
    this.coordinates.set(event.seq, {
      ...turn === undefined ? {} : { turn },
      ...turn === undefined || step === undefined ? {} : { step },
    })
    if (turn !== undefined) this.indexTurnSeq(turn, event.seq)
    this.locations.set(event.seq, this.resolve(event.seq))
  }

  private indexTurnSeq(turn: number, seq: number): void {
    const current = this.seqsByTurn.get(turn) ?? new Set<number>()
    current.add(seq)
    this.seqsByTurn.set(turn, current)
  }

  private turnData(turn: number): ConversationLocationDataStore<ConversationTurnDataMap> {
    return this.mutableTurnData(turn) as ConversationLocationDataStore<ConversationTurnDataMap>
  }

  private stepData(turn: number, step: number): ConversationLocationDataStore<ConversationStepDataMap> {
    return this.mutableStepData(stepDataKey(turn, step)) as ConversationLocationDataStore<ConversationStepDataMap>
  }

  private mutableTurnData(turn: number): MutableLocationDataStore {
    const current = this.turnDataStores.get(turn) ?? this.createDataStore()
    this.turnDataStores.set(turn, current)
    return current
  }

  private mutableStepData(key: string): MutableLocationDataStore {
    const current = this.stepDataStores.get(key) ?? this.createDataStore()
    this.stepDataStores.set(key, current)
    return current
  }

  private createDataStore(): MutableLocationDataStore {
    return new MutableLocationDataStore(store => this.dirtyDataStores.add(store))
  }

  private storeFor(data: ConversationLocationData): MutableLocationDataStore {
    return data.kind === 'turn'
      ? this.mutableTurnData(data.turn)
      : this.mutableStepData(stepDataKey(data.turn, requireStep(data)))
  }

  private resolve(seq: number): ConversationLocation {
    const coordinates = this.coordinates.get(seq)
    if (coordinates?.turn === undefined) return SESSION_LOCATION
    const turn = this.timeline.turns.get(coordinates.turn)
    if (turn === undefined) return UNRESOLVED_LOCATION
    if (coordinates.step === undefined) return { kind: 'turn', turn }
    const step = turn.steps.find(candidate => candidate.step === coordinates.step)
    return step === undefined ? { kind: 'turn', turn } : { kind: 'step', turn, step }
  }
}

function stepDataKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function requireStep(data: ConversationLocationData): number {
  if (data.kind === 'step' && data.step !== undefined) return data.step
  throw new Error(`conversation Step data "${data.key}" requires a step`)
}
