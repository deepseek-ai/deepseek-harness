/**
 * Agent-scoped Schedule management tools over the durable session fold.
 * @module @deepseek-ai/dsh-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  allocateScheduleId,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  foldScheduleEvents,
  MIN_EVERY_INTERVAL_SECONDS,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  scheduleView,
} from './domain.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'
import type {
  AtInput,
  PersistenceUncertainError,
  ScheduleCreateValue,
  ScheduleDeleteValue,
  ScheduleId as ScheduleIdType,
  InternalScheduleError,
  ScheduleListValue,
  SchedulePersistenceOperation,
  ScheduleRecord,
  ScheduleToolError,
} from './types.ts'

const SHARED_VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  deliveryMode: { type: 'string', required: true, const: 'session-local' },
} as const

const AFTER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'after' },
    afterSeconds: { type: 'integer', required: true },
  },
} as const

const AT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'at' },
  },
} as const

const EVERY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'every' },
    everySeconds: { type: 'integer', required: true },
  },
} as const

const VIEW_SCHEMA = { oneOf: [AFTER_VIEW_SCHEMA, AT_VIEW_SCHEMA, EVERY_VIEW_SCHEMA] } as const

/** Build one exact two-field error schema while preserving its literal code. */
function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const BASIC_ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('not_future'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('corrupt_schedule_log'),
  basicErrorSchema('internal_error'),
] as const

const PERSISTENCE_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, const: 'persistence_uncertain' },
    message: { type: 'string', required: true },
    operation: { type: 'string', required: true, enum: ['create', 'list', 'delete'] },
    id: { type: 'string' },
  },
} as const

const ERROR_SCHEMAS = [
  ...BASIC_ERROR_SCHEMAS,
  PERSISTENCE_ERROR_SCHEMA,
] as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: VIEW_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: false },
        code: { type: 'string', required: true, const: 'schedule_not_found' },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const CREATE_DESCRIPTION =
  'Create one reminder in the current session. Supply a non-empty prompt and exactly one selector: '
  + 'a positive safe-integer after_seconds delay, at as a strict offset date-time or local '
  + `date/time object, or safe-integer every_seconds of at least ${MIN_EVERY_INTERVAL_SECONDS}. `
  + 'Fixed-rate reminders stay creation-aligned, skip missed occurrences, and batch one latest '
  + 'occurrence per overdue rule. '
  + 'Delivery is session-local: the reminder runs on time only while this session '
  + 'is live and otherwise becomes overdue until the session is resumed.'

const LIST_DESCRIPTION =
  'List every active reminder in the current session in creation order, including its exact id, '
  + 'UTC target, scheduled or overdue state, and session-local delivery mode.'

const DELETE_DESCRIPTION =
  'Delete one active reminder in the current session by the exact id returned by schedule_create '
  + 'or schedule_list. Unknown or already-finished ids return deleted false.'

/** Deterministic model content for every canonical Schedule value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable error for failures not safe to expose. */
function internalError(): InternalScheduleError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/** Placeholder the registry replaces with its canonical ABORTED result after body quiescence. */
function cancellationPlaceholder(signal: AbortSignal): InternalScheduleError | undefined {
  return signal.aborted ? internalError() : undefined
}

/** Serialize one operation, stopping a body whose caller cancelled before its FIFO turn. */
function runCancellableScheduleTransaction<T>(
  agent: Agent,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T | InternalScheduleError> {
  return runScheduleTransaction(agent, async () => {
    const cancelled = cancellationPlaceholder(signal)
    return cancelled ?? task()
  })
}

/** Stable durable-log failure. */
function corruptLogError(): ScheduleToolError {
  return { code: 'corrupt_schedule_log', message: 'The session schedule log is corrupt.' }
}

/** Stable persistence uncertainty with the known operation identity. */
function persistenceError(
  operation: SchedulePersistenceOperation,
  id?: ScheduleIdType,
): PersistenceUncertainError {
  return {
    code: 'persistence_uncertain',
    message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
    operation,
    ...id === undefined ? {} : { id },
  }
}

/** Translate one contained input failure to the closed tool union. */
function inputError(error: ScheduleInputError): ScheduleToolError {
  return { code: error.code, message: error.message }
}

/** Fold only after a successful preflight, mapping corruption to a stable value. */
function foldForTool(agent: Agent): ReturnType<typeof foldScheduleEvents> | ScheduleToolError {
  try {
    return foldScheduleEvents(agent.session.snapshotEvents(), agent.session.header.seedLength ?? 0)
  } catch (error: unknown) {
    return error instanceof ScheduleLogError ? corruptLogError() : internalError()
  }
}

/** Whether a fold attempt produced an error rather than replay state. */
function isToolError(
  value: ReturnType<typeof foldScheduleEvents> | ScheduleToolError,
): value is ScheduleToolError {
  return 'code' in value
}

/** Require one persistence checkpoint without leaking the backend failure. */
async function preflight(
  rootCtx: Context,
  agent: Agent,
  operation: SchedulePersistenceOperation,
  id?: ScheduleIdType,
): Promise<PersistenceUncertainError | undefined> {
  try {
    await flushSchedulePersistence(rootCtx, agent.session)
    return undefined
  } catch {
    return persistenceError(operation, id)
  }
}

/** Validate the v1 selector constraints that the open parameter root cannot express. */
function validateCreateArgs(args: {
  prompt: string
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
}): ScheduleToolError | undefined {
  const keys = Object.keys(args as unknown as Record<string, unknown>)
  if (keys.some(key => key !== 'prompt'
    && key !== 'after_seconds'
    && key !== 'at'
    && key !== 'every_seconds')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined) !== 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly one of after_seconds, at, or every_seconds.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (args.after_seconds !== undefined
    && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  if (args.every_seconds !== undefined && !Number.isSafeInteger(args.every_seconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (args.every_seconds !== undefined && args.every_seconds < MIN_EVERY_INTERVAL_SECONDS) {
    return {
      code: 'frequency_too_high',
      message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    }
  }
  return undefined
}

/**
 * Register all three Schedule tools in one exact agent scope.
 * @param rootCtx - Global service context owning sessions and durability.
 * @param toolCtx - Exact agent-scoped context receiving the definitions.
 * @param agent - Exact live owner whose session the tools mutate.
 * @param onDurableChange - Called after every successful preflight and again after a create or actual delete barrier succeeds.
 * @returns Idempotent aggregate disposer for the three registrations.
 */
export function registerScheduleTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  onDurableChange: () => void,
): () => void {
  const disposers: Array<() => void> = []

  /** A projection observer cannot reverse a completed durability barrier. */
  const notifyDurableChange = (): void => {
    try {
      onDurableChange()
    } catch (error: unknown) {
      rootCtx.logger.warn(`schedule: durable-change observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Reminder content to present when the target becomes due.',
        },
        after_seconds: {
          type: 'number',
          description: 'Positive safe-integer delay in seconds.',
        },
        every_seconds: {
          type: 'number',
          description: `Fixed-rate safe-integer interval in seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
        },
        at: {
          description: 'Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.',
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                time: { type: 'string', required: true },
                time_zone: { type: 'string', required: true },
              },
            },
          ],
        },
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleCreateValue> {
        if (exec.agent !== agent) return internalError()
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return invalid
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'create')
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const id = allocateScheduleId(folded)
          let record: ScheduleRecord
          try {
            if (args.at !== undefined) {
              record = createAtScheduleRecord(id, args.prompt, args.at, Date.now())
            } else if (args.after_seconds !== undefined) {
              record = createAfterScheduleRecord(id, args.prompt, args.after_seconds, Date.now())
            } else {
              record = createEveryScheduleRecord(
                id,
                args.prompt,
                args.every_seconds as number,
                Date.now(),
              )
            }
          } catch (error: unknown) {
            return error instanceof ScheduleInputError ? inputError(error) : internalError()
          }
          const cancelledBeforeAppend = cancellationPlaceholder(exec.signal)
          if (cancelledBeforeAppend !== undefined) return cancelledBeforeAppend
          try {
            agent.session.append('schedule/change', {
              version: 1,
              operation: 'create',
              schedule: record,
            })
          } catch {
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'create', id)
          if (barrier !== undefined) return barrier
          notifyDurableChange()
          return scheduleView(record, Date.now())
        })
      },
      presentCall: args => present('Create reminder', 'other', args.prompt),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<ScheduleListValue> {
        if (exec.agent !== agent) return internalError()
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'list')
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const now = Date.now()
          return folded.active.map(record => scheduleView(record, now))
        })
      },
      presentCall: () => present('List reminders', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_delete',
      description: DELETE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
      },
      output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleDeleteValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        if (exec.agent !== agent) return internalError()
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'delete', id)
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          if (!folded.active.some(record => record.id === id)) {
            return { id, deleted: false, code: 'schedule_not_found' }
          }
          const cancelledBeforeAppend = cancellationPlaceholder(exec.signal)
          if (cancelledBeforeAppend !== undefined) return cancelledBeforeAppend
          try {
            agent.session.append('schedule/change', { version: 1, operation: 'delete', id })
          } catch {
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'delete', id)
          if (barrier !== undefined) return barrier
          notifyDurableChange()
          return { id, deleted: true }
        })
      },
      presentCall: args => present('Delete reminder', 'other', args.id),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
