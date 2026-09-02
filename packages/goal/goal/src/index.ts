/**
 * Same-session goal domain: event-sourced state, compare-and-set mutations,
 * and process-local continuation activation.
 * @module @deepseek-ai/dsh-goal
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  applyGoalEvent,
  goalChangeRef,
} from './fold.ts'
import type { GoalFoldState } from './fold.ts'
import {
  GOAL_CHANGE_VERSION,
  GoalError,
  GoalId,
} from './runtime.ts'
import type {
  CreateGoalRequest,
  CreateGoalResult,
  EditGoalRequest,
  GoalActivation,
  GoalBlockReason,
  GoalPhase,
  GoalProjection,
  GoalProjectionState,
  GoalRef,
  GoalSnapshot,
  GoalView,
} from './types.ts'
import type {
  GoalChangeMeta,
  GoalChanged,
  GoalClearChangeMeta,
  GoalOperation,
  GoalSnapshotChangeMeta,
} from './domain.ts'

// The pure payload outlet (./types.ts, ONE home of the `goal` projection-key
// declaration) re-exported onto the package root keeps the module edge in
// the emitted index.d.ts, so aggregate programs consuming the declarations
// still receive the SessionProjectionStateMap merge.
export type * from './types.ts'
export type * from './domain.ts'
export { GOAL_CHANGE_VERSION, GoalError, GoalId } from './runtime.ts'
export { decodeGoalChange, foldGoal, goalChangeRef } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    goals: GoalService
  }
}

/** Wire payload schema of the `goal` projection (current goal or pre-create/cleared null). */
const goalProjectionSchema: ZodType<GoalProjection | null> = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([zod.literal('active'), zod.literal('paused'), zod.literal('blocked'), zod.literal('complete')]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      maxGoalRounds: zod.number().int().positive(),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<GoalProjection | null>

const goalProjectionStateSchema: ZodType<GoalProjectionState> = zod.object({
  current: goalProjectionSchema,
  seenGoalIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen goal ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  if (!state.seenGoalIds.includes(state.current.goal.id)) {
    context.addIssue({ code: 'custom', message: 'current goal id must be retained among seen goal ids' })
  }
  if (state.current.updatedAt < state.current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current goal update cannot precede its creation' })
  }
  if (state.current.roundsStarted > state.current.goal.maxGoalRounds) {
    context.addIssue({ code: 'custom', message: 'current goal rounds cannot exceed its configured limit' })
  }
}) as unknown as ZodType<GoalProjectionState>

/** Build strict fold state from one checkpoint-safe projection state. */
function goalFoldState(state: GoalProjectionState): GoalFoldState {
  return {
    goal: state.current?.goal,
    roundsStarted: state.current?.roundsStarted ?? 0,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenGoalIds: new Set(state.seenGoalIds),
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function goalProjectionState(state: GoalFoldState): GoalProjectionState {
  let current: GoalProjection | null = null
  if (state.goal !== undefined) {
    const { createdAt, updatedAt } = state
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current goal fold lacks timestamps')
    }
    current = {
      goal: state.goal,
      roundsStarted: state.roundsStarted,
      createdAt,
      updatedAt,
    }
  }
  return {
    current,
    seenGoalIds: [...state.seenGoalIds],
    failure: null,
  }
}

/**
 * Fold durable goal events through the strict replay rules without throwing
 * from the projection registry's event drive. The first invalid owned event
 * is retained in `failure`; host goal access rejects that state while the
 * client view remains at the last valid goal.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is unrelated).
 */
export function applyGoalProjection(state: GoalProjectionState, event: SessionEvent): GoalProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'goal/change'
    && (event.type !== 'user/message' || event.data.source.kind !== 'goal')) return state
  const folded = goalFoldState(state)
  try {
    applyGoalEvent(folded, event)
    return goalProjectionState(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict goal fold throws Error instances. */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `goal replay failed at session event ${event.seq}: ${message}` }
  }
}

/** Strict host goal state with the existing cropped client value. */
export const goalProjectionDefinition = {
  key: 'goal',
  stateSchema: goalProjectionStateSchema,
  init: (): GoalProjectionState => ({ current: null, seenGoalIds: [], failure: null }),
  apply: applyGoalProjection,
  wire: { viewSchema: goalProjectionSchema, view: state => state.current },
  stateVersion: 6,
} satisfies ProjectionDefinition<'goal', GoalProjectionState>

/** Deployment defaults for goal creation. */
export interface Config {
  /** Total rounds used when a create request omits its own cap. */
  defaultMaxGoalRounds?: number
}

/** Resolved defaults. */
export interface ResolvedConfig {
  /** Validated positive safe-integer default round cap. */
  defaultMaxGoalRounds: number
}

/** Process-local activation state crossing the synchronous append boundary. */
interface GoalRuntimeState {
  activation: GoalActivation
  pendingActivation: {
    readonly offset: SessionLogOffset
    readonly activation: GoalActivation
  } | undefined
}

/** Validated create input with every deployment default materialized. */
interface ResolvedCreateGoal {
  readonly objective: string
  readonly maxGoalRounds: number
}

/** Validate a caller-visible positive safe-integer round cap. */
function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

/** Validate and normalize an objective at the domain boundary. */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/** Materialize deployment defaults and validate one create request. */
function resolveCreateGoal(request: CreateGoalRequest, defaultMaxGoalRounds: number): ResolvedCreateGoal {
  return {
    objective: resolveObjective(request.objective),
    maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds ?? defaultMaxGoalRounds),
  }
}

/** Validate and detach one policy-owned blocker explanation. */
function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

/** Goal service (`ctx.goals`) backed exclusively by the owning session log. */
export class GoalService extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultMaxGoalRounds: z.number().default(256),
  })

  private readonly resolved: ResolvedConfig
  private readonly runtimeStates = new WeakMap<Session, GoalRuntimeState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'goals')
    this.resolved = {
      defaultMaxGoalRounds: resolveMaxGoalRounds(config.defaultMaxGoalRounds ?? 256),
    }
    ctx.on('agent/session-start', ({ agent }) => {
      this.runtimeState(agent.session).activation = 'disarmed'
    })
    ctx.sessionProjections.register(goalProjectionDefinition)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'goal/change') return
      const runtime = this.runtimeState(session)
      runtime.activation = runtime.pendingActivation !== undefined
        && SessionSeq(runtime.pendingActivation.offset) === event.seq
        ? runtime.pendingActivation.activation
        : 'disarmed'
    })
  }

  /**
   * Read the current goal for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view or `undefined` when no goal is current.
   * @throws {@link GoalError} when the agent is not the registry's live instance.
   */
  get(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    return this.view(this.state(agent.session), this.runtimeState(agent.session))
  }

  /**
   * Remove process-local continuation authority without changing durable goal
   * phase or revision. Lifecycle owners use this before unloading a driver;
   * a later human-authorized {@link resume} records the new activation edge.
   * @param agent - owning live agent.
   * @returns a fresh disarmed view, or `undefined` when no goal is current.
   */
  disarm(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    const runtime = this.runtimeState(agent.session)
    runtime.activation = 'disarmed'
    return this.view(this.state(agent.session), runtime)
  }

  /**
   * Create and arm a goal. A completed goal may be replaced; every other
   * current phase must be cleared or resumed instead.
   * @param agent - owning live agent.
   * @param request - objective and optional round cap.
   * @returns the created live view.
   */
  create(agent: Agent, request: CreateGoalRequest): GoalView {
    const spec = resolveCreateGoal(request, this.resolved.defaultMaxGoalRounds)
    const [state, runtime] = this.prepareMutation(agent)
    const current = state?.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS')
    }
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: GoalId(`goal-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxGoalRounds: spec.maxGoalRounds,
    }
    return this.commitSnapshot(agent, runtime, 'create', goal, 0, now, now, 'armed')
  }

  /**
   * Edit objective and/or round cap without changing phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param request - at least one replacement field.
   * @returns the edited view.
   */
  @Remote('edit')
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT')
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...request.objective === undefined ? {} : { objective: resolveObjective(request.objective) },
      ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) },
    }
    return this.commitCurrent(agent, currentState, runtime, 'edit', goal, runtime.activation)
  }

  /**
   * Pause an active goal and disarm automatic continuation.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  @Remote('pause')
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /**
   * Resume and arm a stopped goal, or rearm an active goal after a
   * session-start edge, while its round budget still has capacity.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view.
   */
  @Remote('resume')
  resume(agent: Agent, ref: GoalRef): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && runtime.activation === 'armed') {
      throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (currentState.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(agent, currentState, runtime, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /**
   * Mark a current non-complete goal complete and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  @Remote('complete')
  complete(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(
      agent,
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    )
  }

  /**
   * Mark an active goal blocked and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param reason - policy-owned stable code and human-readable explanation.
   * @returns the blocked view with its durable reason.
   */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'block', ['active'])
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /**
   * Clear the current goal while retaining a durable tombstone and history.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  @Remote('clear')
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, runtime, change, 'disarmed')
    return { ...tombstone }
  }

  /** Resolve the durable and process-local state used by a mutation. */
  private prepareMutation(agent: Agent): readonly [GoalProjection | null, GoalRuntimeState] {
    this.assertLive(agent)
    return [this.state(agent.session), this.runtimeState(agent.session)]
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(state: GoalProjection | null, ref: GoalRef): GoalProjection {
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    const current = state.goal
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return state
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(`agent "${agent.id}" is not live in this registry`, 'GOAL_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private state(session: Session): GoalProjection | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'goal')
    if (state === undefined) throw new Error('goal projection is not registered')
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** Return the process-local activation state, initially disarmed. */
  private runtimeState(session: Session): GoalRuntimeState {
    let runtime = this.runtimeStates.get(session)
    if (runtime !== undefined) return runtime
    runtime = {
      activation: 'disarmed',
      pendingActivation: undefined,
    }
    this.runtimeStates.set(session, runtime)
    return runtime
  }

  /** Build a new revision with one replacement phase. */
  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    }
  }

  /** Shared validated phase transition. */
  private transition(
    agent: Agent,
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, currentState, runtime, operation, this.withPhase(current, phase), activation)
  }

  /** Render a stable invalid-transition error. */
  private transitionError(current: GoalSnapshot, operation: GoalOperation, allowed: readonly GoalPhase[]): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  /** Commit a mutation that retains the current goal's derived counters/times. */
  private commitCurrent(
    agent: Agent,
    state: GoalProjection,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
  ): GoalView {
    return this.commitSnapshot(
      agent,
      runtime,
      operation,
      goal,
      state.roundsStarted,
      state.createdAt,
      this.nextMutationTime(state),
      activation,
    )
  }

  /** Clamp a current goal's next timestamp across backward wall-clock movement. */
  private nextMutationTime(state: GoalProjection): number {
    return Math.max(Date.now(), state.updatedAt)
  }

  /** Build and commit one full-snapshot mutation. */
  private commitSnapshot(
    agent: Agent,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    }
    this.commit(agent, runtime, change, activation)
    return {
      ...goal,
      roundsStarted,
      createdAt,
      updatedAt,
      activation: runtime.activation,
    }
  }

  /** Commit one mutation into the goal log and live event stream. */
  private commit(agent: Agent, runtime: GoalRuntimeState, change: GoalChangeMeta, activation: GoalActivation): void {
    const ref = goalChangeRef(change)
    runtime.pendingActivation = { offset: agent.session.seq, activation }
    try {
      const event = agent.session.append('goal/change', change)
      /* v8 ignore next -- Session.append returns the event committed at the pre-append seq. */
      if (SessionSeq(runtime.pendingActivation.offset) === event.seq) runtime.activation = activation
    } finally {
      runtime.pendingActivation = undefined
    }
    const goal = this.view(this.state(agent.session), runtime)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...goal === undefined ? {} : { goal },
    }
    agentEvents(this.ctx, agent).emit('goal/changed', { change: notification })
  }

  /** Build a detached current view. */
  private view(state: GoalProjection | null, runtime: GoalRuntimeState): GoalView | undefined {
    if (state === null) return undefined
    return {
      ...state.goal,
      roundsStarted: state.roundsStarted,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      activation: runtime.activation,
    }
  }

  /**
   * Create one Goal through the remote boundary.
   * @param agent - exact live Agent resolved from the wire identity.
   * @param request - objective and optional round cap.
   * @returns the created Goal identity.
   */
  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}

export default GoalService
