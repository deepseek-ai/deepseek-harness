import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/* oxlint-disable typescript/no-duplicate-type-constituents, typescript/no-redundant-type-constituents --
 * The unaugmented declaration-merge maps intentionally resolve to never in the Runtime program;
 * installed business packages supply their concrete keys in consuming Client programs. */

/** Definition-local identity and lifecycle role extracted from one event. */
export interface ConversationMatchResult {
  readonly id: string
  readonly role: 'start' | 'update'
}

/** Merge-extensible business values published against one Turn. */
export interface ConversationTurnDataMap {}

/** Merge-extensible business values published against one Step. */
export interface ConversationStepDataMap {}

/** Stable keyed reader for independently owned Location business values. */
export interface ConversationLocationDataStore<DataMap extends object> {
  /**
   * Read one business value without exposing another owner's mutable State.
   * @param key - declaration-merged business key.
   * @returns latest immutable value, when its owning Context has published one.
   */
  get<Key extends keyof DataMap & string>(key: Key): Readonly<DataMap[Key]> | undefined
}

interface ConversationLocationDataValue {
  readonly kind: 'turn' | 'step'
  readonly turn: number
  readonly step?: number
  readonly key: string
  readonly value: unknown
}

type RegisteredTurnData = {
  [Key in keyof ConversationTurnDataMap & string]: {
    readonly kind: 'turn'
    readonly turn: number
    readonly key: Key
    readonly value: ConversationTurnDataMap[Key]
  }
}[keyof ConversationTurnDataMap & string]

type RegisteredStepData = {
  [Key in keyof ConversationStepDataMap & string]: {
    readonly kind: 'step'
    readonly turn: number
    readonly step: number
    readonly key: Key
    readonly value: ConversationStepDataMap[Key]
  }
}[keyof ConversationStepDataMap & string]

/** One Definition-owned value attached to an Engine-owned Turn or Step. */
export type ConversationLocationData =
  [keyof ConversationTurnDataMap | keyof ConversationStepDataMap] extends [never]
    ? ConversationLocationDataValue
    : RegisteredTurnData | RegisteredStepData

/** Immutable resolved boundary for one Agent step. */
export interface StepLocation {
  readonly turn: number
  readonly step: number
  readonly start: SessionEvent<'step/start'> | undefined
  readonly end: SessionEvent<'step/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  /** Stable reader for Step-scoped business values. */
  readonly data: ConversationLocationDataStore<ConversationStepDataMap>
}

/** Immutable resolved boundary for one Agent turn. */
export interface TurnLocation {
  readonly turn: number
  readonly start: SessionEvent<'turn/start'> | undefined
  readonly end: SessionEvent<'turn/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  readonly steps: readonly StepLocation[]
  /** Stable reader for Turn-scoped business values. */
  readonly data: ConversationLocationDataStore<ConversationTurnDataMap>
}

/** Engine-owned placement of one matched event in the Session hierarchy. */
export type ConversationLocation =
  | { readonly kind: 'session' }
  | { readonly kind: 'turn'; readonly turn: TurnLocation }
  | { readonly kind: 'step'; readonly turn: TurnLocation; readonly step: StepLocation }
  | { readonly kind: 'unresolved' }

interface ConversationMatchOf<
  Event extends SessionEventLike,
  Role extends ConversationMatchResult['role'],
> {
  readonly event: Event
  readonly role: Role
  readonly location: ConversationLocation
}

/** One scalar event accepted as a Context's unique start. */
export type ConversationStartMatch = ConversationMatchOf<SessionEvent, 'start'>

/** One event accepted by a Definition, with its lifecycle role and resolved Location. */
export type ConversationMatch =
  | ConversationStartMatch
  | ConversationMatchOf<SessionEventLike, 'update'>

/** Target-neutral identity returned by a business Definition. */
export interface ConversationViewNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: string
  readonly data: unknown
}

/** Merge-extensible immutable snapshots published by registered view targets. */
export interface ConversationViewSnapshotMap {}

/** Stable reader over the latest snapshot of every registered view target. */
export interface ConversationViewSnapshotStore {
  /** @param target - registered view target. @returns its current snapshot. */
  get<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ConversationViewSnapshotMap[Target] | undefined
}

/** Immutable public view of an assembled business Context. */
export interface ConversationNodeContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly matches: readonly ConversationMatch[]
  readonly start: ConversationStartMatch | undefined
  readonly state: State | undefined
  readonly current: ReadonlyMap<string, ConversationViewNode | null>
}

/** Read-only predecessor returned to a Definition's start function. */
export interface ConversationPreviousContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly startSeq: number
  readonly state: Readonly<State>
  readonly matches: readonly ConversationMatch[]
}

/** Strictly-backward Context lookup available while a start is evaluated. */
export interface ConversationContextReader {
  /**
   * Find the active Context of `kind` with the greatest start seq below the
   * current start event.
   * @param kind - Definition kind to query.
   * @returns the nearest predecessor, or undefined when absent in the current window.
   */
  previous<State>(kind: string): ConversationPreviousContext<State> | undefined
}

/** Requested cadence for materializing updated business State into view Nodes. */
export type ConversationPublication = 'none' | 'animation-frame' | 'immediate'

/** Engine-owned Location data publication phase. */
export type ConversationLocationDataScope = 'step' | 'turn'

/** One independently registered business Event-to-Node state machine. */
export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  /** Sole view target owned by this Definition; omitted for state-only Contexts. */
  readonly target?: string
  /**
   * Extract this Definition's stable business identity from one event.
   * @param event - standard or compact Client history event; no Context or history access is available.
   * @returns identity and lifecycle role, or null when unrelated.
   */
  match(event: SessionEventLike): ConversationMatchResult | null
  /**
   * Create State from the unique start Match.
   * @param context - complete evidence currently collected for the Context.
   * @param match - the start Match.
   * @param reader - strictly-backward read-only Context lookup.
   * @returns the State adopted by the engine.
   */
  start(
    context: ConversationNodeContext<State>,
    match: ConversationStartMatch,
    reader: ConversationContextReader,
  ): State
  /**
   * Apply one post-start update Match.
   * @param context - Context with its current State.
   * @param match - update Match in ascending log order.
   * @returns the State adopted by the engine.
   */
  update(
    context: ConversationNodeContext<State> & { readonly state: State },
    match: ConversationMatch,
  ): State
  /**
   * Select publication cadence for one accepted Match.
   * @param match - accepted Match.
   * @returns requested cadence; omission defaults to immediate.
   */
  publication?(match: ConversationMatch): ConversationPublication
  /**
   * Publish this Definition's read-only business value for one Location phase.
   * The Engine evaluates every Definition first for Step and then for Turn,
   * owns replacement/removal, and rejects another Context trying to publish
   * the same Location key.
   * @param context - latest complete Context.
   * @param scope - Location hierarchy level currently being materialized.
   * @returns current Location value, or null while unavailable.
   */
  buildLocationData?(
    context: ConversationNodeContext<State>,
    scope: ConversationLocationDataScope,
  ): ConversationLocationData | null
  /**
   * Materialize one final Node for this Definition's declared view target.
   * @param context - latest complete Context.
   * @returns final Node, or null when this Context is not currently visible.
   */
  buildViewNode?(context: ConversationNodeContext<State>): ConversationViewNode | null
}

/** Reference-stable Turn/Step facts published beside view Nodes. */
export interface ConversationTimelineSnapshot {
  readonly turnOrder: readonly number[]
  readonly turns: ReadonlyMap<number, TurnLocation>
}

/** Per-Session incremental builder for one view target. */
export interface ConversationViewBuilder<Node extends ConversationViewNode = ConversationViewNode, Snapshot = unknown> {
  readonly empty: Snapshot
  /**
   * Replace the low-frequency complete materialized Node set.
   * @param input - complete Nodes and current timeline.
   * @returns next view snapshot.
   */
  replace(input: {
    readonly nodes: readonly Node[]
    readonly timeline: ConversationTimelineSnapshot
  }): Snapshot
  /**
   * Apply only Nodes whose materialized values changed in this transaction.
   * @param input - changed Nodes and current timeline.
   * @returns next view snapshot.
   */
  apply(input: {
    readonly upserts: readonly Node[]
    readonly timeline: ConversationTimelineSnapshot
  }): Snapshot
}

/** Registry contribution that creates an isolated builder when a Session first uses this target. */
export interface ConversationViewDefinition<Node extends ConversationViewNode = ConversationViewNode, Snapshot = unknown> {
  readonly target: string
  /** @returns a new Session-owned incremental builder. */
  create(): ConversationViewBuilder<Node, Snapshot>
  /**
   * Decide whether this target contributes visible Conversation activity.
   * @param snapshot - latest target-owned snapshot.
   * @returns whether the shell should treat this target as active.
   */
  isActive?(snapshot: Snapshot): boolean
}

/**
 * Build a stable collision-free key for one Definition-local business identity.
 * @param kind - Definition kind.
 * @param id - Definition-local business identity.
 * @returns engine-owned Context key.
 */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}
