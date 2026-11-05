/** Team state projected incrementally from committed Session events, with a durable-only client view. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionEventMap, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  TeamId,
  TeamProjection,
  TeamTaskSnapshot,
  TeamTaskView,
} from './types.ts'
import {
  TeamId as toTeamId,
  TeamTaskId as toTeamTaskId,
} from './types.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import { projectTaskView } from './task-view.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonNegativeSafeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform(value => brandString<SessionId>(value))
const teamIdSchema = z.string().min(1).transform(value => toTeamId(value))
const numericTaskIdPattern = /^task-(\d+)$/u
const teamTaskIdSchema = z.string().min(1).refine((value) => {
  const match = numericTaskIdPattern.exec(value)
  return match === null || Number.isSafeInteger(Number(match[1]))
}, { message: 'numeric task id suffix must be a safe integer' }).transform(value => toTeamTaskId(value))
const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  ownerName: z.string().min(1).optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
}).strict().refine(task => task.ownerName === undefined || task.ownerId !== undefined, {
  message: 'task ownerName requires ownerId',
}) as z.ZodType<TeamTaskSnapshot>

const teamEventSelectorSchema = z.object({
  version: nonNegativeSafeInteger,
  teamId: teamIdSchema,
}).loose()

const teamTaskEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  task: teamTaskSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/task']>

/**
 * Task board and saved mode selected by durable Team identity. Mode changes
 * preserve the task collection reference.
 */
export interface TeamState {
  /** Saved selection; absent until an explicit selection or historical task. */
  readonly enabled?: boolean
  readonly id: TeamId
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly nextTaskNumber: number
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity.
 * @param inheritedEventCount - inherited prefix excluded from the new root's Team mode; defaults to zero.
 * @returns empty Team state.
 */
export function emptyTeamState(rootId: SessionId, inheritedEventCount = 0): TeamProjectionState {
  return {
    inheritedEventCount,
    id: toTeamId(rootId),
    tasks: [],
    nextTaskNumber: 1,
  }
}

/** Checkpoint-safe state for the Team owned by the projected Session. */
export interface TeamProjectionState extends TeamState {
  readonly inheritedEventCount: number
  readonly failure?: string
}

const teamModeSchema = z.object({ enabled: z.boolean() }).strict()

const teamProjectionEntrySchema = z.object({
  inheritedEventCount: nonNegativeSafeInteger,
  enabled: z.boolean().optional(),
  id: teamIdSchema,
  tasks: z.array(teamTaskSnapshotSchema),
  nextTaskNumber: positiveSafeInteger,
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjectionState>

/** Decode one persisted Team value and retain the schema failure as its cause. */
function parsePersisted<T>(type: 'team/task' | 'team/mode', schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error })
  }
}

function applyProjectionEvent(state: TeamProjectionState, event: SessionEvent): TeamProjectionState {
  try {
    if (event.type === 'team/mode') {
      if (event.seq < state.inheritedEventCount) return state
      return { ...state, ...parsePersisted(event.type, teamModeSchema, event.data) }
    }
    if (state.failure !== undefined || event.type !== 'team/task') return state
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data)
    if (selector.teamId !== state.id) return state
    if (selector.version !== 2) {
      throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
    }
    return applyTask(state, parsePersisted(event.type, teamTaskEventSchema, event.data).task)
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team transition throws Error instances. */
    return { ...state, failure: state.failure ?? (error instanceof Error ? error.message : String(error)) }
  }
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = [...items]
  if (index < 0) next.push(item)
  else next[index] = item
  return next
}

function applyTask(state: TeamProjectionState, task: TeamTaskSnapshot): TeamProjectionState {
  const index = state.tasks.findIndex(candidate => candidate.id === task.id)
  const prior = state.tasks[index]
  if (prior === undefined && task.revision !== 1) {
    throw new Error(`team task "${task.id}" must begin at revision 1`)
  }
  if (prior !== undefined && task.revision !== prior.revision + 1) {
    throw new Error(`team task "${task.id}" revision is not contiguous`)
  }
  assertTaskGraphCandidate(state.tasks, task)
  let nextTaskNumber = state.nextTaskNumber
  const match = numericTaskIdPattern.exec(task.id)
  if (match !== null) {
    const number = Number(match[1])
    nextTaskNumber = Math.max(
      nextTaskNumber,
      number === Number.MAX_SAFE_INTEGER ? number : number + 1,
    )
  }
  return { ...state, enabled: state.enabled ?? true, tasks: replaceAt(state.tasks, index, task), nextTaskNumber }
}

const teamTaskViewSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
  ownerId: sessionIdSchema.optional(),
  ownerName: z.string().min(1).optional(),
  ready: z.boolean(),
  writeScopeWarnings: z.array(z.string()),
}).strict() as z.ZodType<TeamTaskView>

const teamProjectionSchema = z.object({
  enabled: z.boolean(),
  tasks: z.array(teamTaskViewSchema),
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjection>

/** Client views keyed by their task collection and checked against the saved mode. */
const teamProjectionViews = new WeakMap<readonly TeamTaskSnapshot[], TeamProjection>()

function buildTeamProjection(state: TeamProjectionState): TeamProjection {
  return {
    enabled: state.enabled === true,
    tasks: state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => projectTaskView(state, task)),
    ...state.failure === undefined ? {} : { failure: state.failure },
  }
}

/**
 * Durable client view of one Team state, reused while tasks and mode remain unchanged.
 * A task-board failure retains the last valid tasks; mode selections still apply.
 * @param state - current Team state.
 * @returns the saved selection and non-deleted task board, plus any projection failure.
 */
export function teamProjectionView(state: TeamProjectionState): TeamProjection {
  if (state.failure !== undefined) return buildTeamProjection(state)
  let view = teamProjectionViews.get(state.tasks)
  if (view === undefined || view.enabled !== (state.enabled === true)) {
    view = buildTeamProjection(state)
    teamProjectionViews.set(state.tasks, view)
  }
  return view
}

/**
 * Team projection selected by the projected Session identity; the wire view
 * carries the selection and task board. Current subagents are
 * supplied separately by the existing `subagentCatalog` projection.
 * Version-7 checkpoints without owner names remain usable without backfilling.
 */
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 7,
  stateSchema: teamProjectionEntrySchema,
  init: (header, inheritedEventCount: SessionLogOffset) => emptyTeamState(header.id, inheritedEventCount),
  apply: applyProjectionEvent,
  wire: { viewSchema: teamProjectionSchema, view: teamProjectionView },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
