/** Team state projected incrementally from committed Session events, with a durable-only client view. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  TeamId,
  TeamMemberProjection,
  TeamMemberSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamProjection,
  TeamTaskSnapshot,
  TeamTaskView,
} from './types.ts'
import {
  TeamId as toTeamId,
  TeamMessageId as toTeamMessageId,
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
const teamMessageIdSchema = z.string().min(1).transform(value => toTeamMessageId(value))

const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const imageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: nonNegativeSafeInteger,
  width: positiveSafeInteger,
  height: positiveSafeInteger,
  name: z.string().optional(),
}).strict()

// Validate the listed variants; retired tool-result tags cannot enter the
// merge-extensible fallback for JSON-decoded plugin content.
const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
  z.object({
    type: z.literal('tool-call'),
    id: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  }).strict(),
  // Keep unknown JSON objects by reference; loose-object parsing drops their own __proto__ keys.
  z.custom<ContentBlock>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const type = (value as { type?: unknown }).type
    return typeof type === 'string' && type.length > 0 && !coreContentBlockTypes.has(type)
  }),
])) as z.ZodType<ContentBlock>

const teamMemberSnapshotSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  phase: z.enum(['provisioning', 'active', 'failed']),
  error: z.string().optional(),
}).strict() as z.ZodType<TeamMemberSnapshot>

const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
}).strict() as z.ZodType<TeamTaskSnapshot>

const teamMessageSnapshotSchema = z.object({
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  content: z.array(contentBlockSchema),
}).strict() as z.ZodType<TeamMessageSnapshot>

const teamEventSelectorSchema = z.object({
  version: nonNegativeSafeInteger,
  teamId: teamIdSchema,
}).loose()

const teamMemberEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  member: teamMemberSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/member']>

const teamTaskEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  task: teamTaskSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/task']>

const teamMessageQueuedEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  message: teamMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued']>

const teamMessageDeliveredEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  messageId: teamMessageIdSchema,
  targetId: sessionIdSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/delivered']>

/**
 * Current Team state selected by durable Team identity. Every applied Team
 * event produces a new state object and replaces only the collection it
 * touched; untouched collections keep their references.
 */
export interface TeamState {
  readonly id: TeamId
  readonly members: readonly TeamMemberSnapshot[]
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly messages: readonly TeamMessageSnapshot[]
  readonly delivered: readonly TeamMessageId[]
  readonly nextTaskNumber: number
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity.
 * @returns empty Team state.
 */
export function emptyTeamState(rootId: SessionId): TeamProjectionState {
  return {
    id: toTeamId(rootId),
    members: [],
    tasks: [],
    messages: [],
    delivered: [],
    nextTaskNumber: 1,
  }
}

/** Checkpoint-safe state for the Team owned by the projected Session. */
export interface TeamProjectionState extends TeamState {
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState
  }
}

const teamProjectionEntrySchema = z.object({
  id: teamIdSchema,
  members: z.array(teamMemberSnapshotSchema),
  tasks: z.array(teamTaskSnapshotSchema),
  messages: z.array(teamMessageSnapshotSchema),
  delivered: z.array(teamMessageIdSchema),
  nextTaskNumber: positiveSafeInteger,
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjectionState>

/** Whether one event belongs to the Team domain. */
export type TeamEventType =
  | 'team/member'
  | 'team/task'
  | 'team/message/queued'
  | 'team/message/delivered'

/** One event owned by the Team domain. */
type TeamSessionEvent = SessionEvent<TeamEventType>

/**
 * Test whether a Session event belongs to the Team domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Team-owned type.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member'
    || event.type === 'team/task'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/delivered'
}

/** Decode one persisted Team value and retain the schema failure as its cause. */
function parsePersisted<T>(type: TeamEventType, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error })
  }
}

/** Decode the complete current-version payload selected by one Team event type. */
function parseCurrentTeamEvent(event: TeamSessionEvent): TeamSessionEvent {
  switch (event.type) {
    case 'team/member':
      return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
    case 'team/task':
      return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, event.data) }
    case 'team/message/queued':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
    case 'team/message/delivered':
      return { ...event, data: parsePersisted(event.type, teamMessageDeliveredEventSchema, event.data) }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return event
  }
}

function applyProjectionEvent(state: TeamProjectionState, event: SessionEvent): TeamProjectionState {
  if (state.failure !== undefined) return state
  if (!isTeamEvent(event)) return state
  try {
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data)
    if (selector.teamId !== state.id) return state
    if (selector.version !== 2) {
      throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
    }
    return applyCurrentTeamEvent(state, parseCurrentTeamEvent(event))
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team transition throws Error instances. */
    return { ...state, failure: error instanceof Error ? error.message : String(error) }
  }
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = [...items]
  if (index < 0) next.push(item)
  else next[index] = item
  return next
}

function applyCurrentTeamEvent(state: TeamProjectionState, event: TeamSessionEvent): TeamProjectionState {
  switch (event.type) {
    case 'team/member': {
      const member = event.data.member
      const index = state.members.findIndex(candidate => candidate.id === member.id)
      const prior = state.members[index]
      const named = state.members.find(candidate => candidate.name === member.name)
      if (named !== undefined && named.id !== member.id) {
        throw new Error(`teammate name "${member.name}" is reused by another member`)
      }
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
      } else {
        if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      return { ...state, members: replaceAt(state.members, index, member) }
    }
    case 'team/task': {
      const task = event.data.task
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
      return { ...state, tasks: replaceAt(state.tasks, index, task), nextTaskNumber }
    }
    case 'team/message/queued': {
      const message = event.data.message
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      return { ...state, messages: [...state.messages, message] }
    }
    case 'team/message/delivered': {
      const queued = state.messages.find(message => message.id === event.data.messageId)
      if (queued === undefined) throw new Error(`team message "${event.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== event.data.targetId) throw new Error(`team message "${event.data.messageId}" target changed`)
      if (state.delivered.includes(event.data.messageId)) throw new Error(`team message "${event.data.messageId}" was delivered twice`)
      return { ...state, delivered: [...state.delivered, event.data.messageId] }
    }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return state
  }
}

const teamMemberProjectionSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  role: z.enum(['lead', 'teammate']),
  phase: z.enum(['provisioning', 'active', 'failed']),
  error: z.string().optional(),
}).strict() as z.ZodType<TeamMemberProjection>

const teamTaskViewSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
  ownerName: z.string().optional(),
  ready: z.boolean(),
  writeScopeWarnings: z.array(z.string()),
}).strict() as z.ZodType<TeamTaskView>

const teamProjectionSchema = z.object({
  members: z.array(teamMemberProjectionSchema),
  tasks: z.array(teamTaskViewSchema),
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjection>

/** Client views keyed by the member and task collections they were derived from. */
const teamProjectionViews = new WeakMap<readonly TeamMemberSnapshot[], WeakMap<readonly TeamTaskSnapshot[], TeamProjection>>()

function buildTeamProjection(state: TeamProjectionState): TeamProjection {
  const rootId = brandString<SessionId>(state.id)
  const members: TeamMemberProjection[] = [{ id: rootId, name: 'lead', role: 'lead', phase: 'active' }]
  for (const member of state.members) {
    members.push({
      id: member.id,
      name: member.name,
      role: 'teammate',
      phase: member.phase,
      ...member.error === undefined ? {} : { error: member.error },
    })
  }
  return {
    members,
    tasks: state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => projectTaskView(state, task)),
    ...state.failure === undefined ? {} : { failure: state.failure },
  }
}

/**
 * Durable client view of one Team state. Mailbox-only state changes reuse the
 * previous view reference, so the live drive publishes nothing for them.
 * A failure is terminal: later events retain the failed state reference and
 * do not republish its view.
 * @param state - current Team state.
 * @returns the roster and non-deleted task board, plus any projection failure.
 */
export function teamProjectionView(state: TeamProjectionState): TeamProjection {
  if (state.failure !== undefined) return buildTeamProjection(state)
  let byTasks = teamProjectionViews.get(state.members)
  if (byTasks === undefined) {
    byTasks = new WeakMap()
    teamProjectionViews.set(state.members, byTasks)
  }
  let view = byTasks.get(state.tasks)
  if (view === undefined) {
    view = buildTeamProjection(state)
    byTasks.set(state.tasks, view)
  }
  return view
}

/** Team projection selected by the projected Session identity; the wire view carries durable roster and task state only. */
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 4,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: applyProjectionEvent,
  wire: { viewSchema: teamProjectionSchema, view: teamProjectionView },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
