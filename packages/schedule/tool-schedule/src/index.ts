/**
 * Model-facing `schedule_create`, `schedule_list`, `schedule_update`, and
 * `schedule_delete` tools over the Host `ctx.schedule` service. Mounting the
 * plugin registers them in the mounting scope, so a preset decides which
 * agents receive them; every call acts on the calling Agent's Session.
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, ScheduleId, ScheduleInputError, scheduleView,
} from '@deepseek-ai/dsh-schedule'
import type {
  AtInput, CronInput, DailyInput, WeeklyInput, InternalScheduleError, ScheduleCreateValue, ScheduleDeleteValue,
  ScheduleListValue, ScheduleTimingChange, ScheduleToolError, ScheduleUpdateValue,
} from '@deepseek-ai/dsh-schedule'

/** Plugin name registered with the Loader. */
export const name = 'tool-schedule'

/** Host services this plugin consumes. The Schedule service is resolved per
 * scope, so a preset that declares this plugin stays inert while the shipped
 * composition keeps that service off. */
export const inject = ['tools']

const SHARED_VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  deliveryMode: { type: 'string', required: true, const: 'host' },
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

const DAILY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'daily' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

const WEEKLY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'weekly' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
    weekdays: { type: 'array', required: true, items: { type: 'integer' } },
  },
} as const

const CRON_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'cron' },
    expression: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

const VIEW_SCHEMA = {
  oneOf: [
    AFTER_VIEW_SCHEMA, AT_VIEW_SCHEMA, EVERY_VIEW_SCHEMA, DAILY_VIEW_SCHEMA, WEEKLY_VIEW_SCHEMA, CRON_VIEW_SCHEMA,
  ],
} as const

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

const ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('not_future'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('subagent_session'),
  basicErrorSchema('internal_error'),
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

const UPDATE_OUTPUT_SCHEMA = {
  oneOf: [
    VIEW_SCHEMA,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        updated: { type: 'boolean', required: true, const: false },
        code: {
          type: 'string',
          required: true,
          enum: ['schedule_not_found', 'schedule_ended', 'schedule_conflict'],
        },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const CREATE_DESCRIPTION =
  'Create a reminder in the current session that delivers prompt when it becomes due. '
  + 'Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. '
  + 'Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. '
  + 'After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.'

const LIST_DESCRIPTION = 'List the active reminders in the current session.'

const DELETE_DESCRIPTION =
  'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.'

const UPDATE_DESCRIPTION =
  'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; '
  + 'omitted fields keep their stored values. To change a relative delay, create a new reminder.'

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

/** Translate invalid input while withholding internal storage failures. */
function operationError(error: unknown): ScheduleToolError {
  return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : internalError()
}

/**
 * Refuse a caller that is a delegated child. A subagent cannot use reminders at
 * all, so every tool rejects before dispatch instead of relying on the mounting
 * preset's tool filter alone.
 * @param agent - the calling agent, when the outer call has one.
 * @returns the stable refusal, or undefined for a top-level caller.
 */
function subagentCallerRefusal(agent: Agent | undefined): ScheduleToolError | undefined {
  if (agent === undefined || delegationDepthOf(agent) === 0) return undefined
  return { code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }
}

/** One supplied fixed-rate interval: a safe integer at or above the Host floor, or undefined. */
function invalidInterval(everySeconds: number | undefined): ScheduleToolError | undefined {
  if (everySeconds === undefined) return undefined
  if (!Number.isSafeInteger(everySeconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return {
      code: 'frequency_too_high',
      message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    }
  }
  return undefined
}

/** Validate selector constraints that the open parameter root cannot express. */
function validateCreateArgs(args: {
  prompt: string
  title: string
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const keys = Object.keys(args)
  if (keys.some(key => key !== 'prompt'
    && key !== 'title'
    && key !== 'after_seconds'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined)
    + Number(args.daily !== undefined)
    + Number(args.weekly !== undefined)
    + Number(args.cron !== undefined) !== 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.after_seconds !== undefined
    && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

/** Validate the in-place update's selector count, id, and any supplied name, instruction, or interval. */
function validateUpdateArgs(args: {
  id: string
  title?: string
  prompt?: string
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const selectors = [
    args.at !== undefined,
    args.every_seconds !== undefined,
    args.daily !== undefined,
    args.weekly !== undefined,
    args.cron !== undefined,
  ].filter(Boolean).length
  if (Object.keys(args).some(key => key !== 'id'
    && key !== 'title'
    && key !== 'prompt'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || selectors > 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.id.length === 0 || args.id.trim() !== args.id) {
    return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.title !== undefined && args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title !== undefined && args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.prompt !== undefined && args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  return invalidInterval(args.every_seconds)
}

/** The one timing replacement the update carries, or undefined when the request keeps the committed target. */
function timingChangeFrom(args: {
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleTimingChange | undefined {
  if (args.at !== undefined) return { kind: 'at', at: args.at }
  if (args.every_seconds !== undefined) return { kind: 'every', every_seconds: args.every_seconds }
  if (args.daily !== undefined) return { kind: 'daily', daily: args.daily }
  if (args.weekly !== undefined) return { kind: 'weekly', weekly: args.weekly }
  if (args.cron !== undefined) return { kind: 'cron', cron: args.cron }
  return undefined
}

/**
 * Selector parameters shared by `schedule_create` and `schedule_update`, in the order the
 * generated tool catalog states them.
 */
const SELECTOR_PARAMETERS = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.`,
  },
  daily: {
    type: 'object',
    additionalProperties: false,
    description: 'Every day at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  weekly: {
    type: 'object',
    additionalProperties: false,
    description: 'On the given weekdays at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
      weekdays: {
        type: 'array',
        required: true,
        description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.',
        items: { type: 'integer' },
      },
    },
  },
  cron: {
    type: 'object',
    additionalProperties: false,
    description: 'Five-field Vixie cron expression in a time zone.',
    properties: {
      expression: {
        type: 'string',
        required: true,
        description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". '
          + 'When both day fields are restricted, a date matches if either one matches.',
      },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  at: {
    description: 'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
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
} as const

/**
 * Register the four Schedule tools in the mounting scope.
 *
 * Each call mutates the Session of the Agent that dispatched it, so a mount
 * outside an agent scope still registers the tools but every call without a
 * caller Agent is refused as an internal failure.
 * @param ctx - Context owning the `tools` registry and the Host `schedule` service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['schedule'], (scheduleCtx) => { registerScheduleTools(scheduleCtx) })
}

/**
 * Register the four reminder tools in the scope that resolved the Schedule
 * service.
 * @param ctx - Scope whose `schedule` service the tools act through.
 */
function registerScheduleTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'schedule_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Reminder content to present when the target becomes due.',
      },
      title: {
        type: 'string',
        required: true,
        description: `Task name of at most ${MAX_TITLE_LENGTH} characters, shown on the task card and in task lists.`,
      },
      after_seconds: {
        type: 'number',
        description: 'Delay in whole seconds.',
      },
      ...SELECTOR_PARAMETERS,
    },
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<ScheduleCreateValue> {
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      const invalid = validateCreateArgs(args)
      if (invalid !== undefined) return invalid
      if (exec.signal.aborted) return internalError()
      try {
        return scheduleView(await ctx.schedule.create(agent.session.id, args, exec.signal), Date.now())
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: args => present('Create reminder', 'other', args.prompt),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
    async execute(_args, exec): Promise<ScheduleListValue> {
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      if (exec.signal.aborted) return internalError()
      try {
        const records = await ctx.schedule.list({ sessionId: agent.session.id })
        return records.map(record => scheduleView(record, Date.now()))
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: () => present('List reminders', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact schedule id.' },
    },
    output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<ScheduleDeleteValue> {
      if (args.id.length === 0 || args.id.trim() !== args.id) {
        return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
      }
      const id = ScheduleId(args.id)
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      if (exec.signal.aborted) return internalError()
      try {
        return await ctx.schedule.delete({ sessionId: agent.session.id, id }, exec.signal)
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: args => present('Delete reminder', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_update',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Schedule id returned by schedule_list.' },
      title: {
        type: 'string',
        description: `New task name of at most ${MAX_TITLE_LENGTH} characters.`,
      },
      prompt: {
        type: 'string',
        description: 'New reminder content.',
      },
      ...SELECTOR_PARAMETERS,
    },
    output: { schema: UPDATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<ScheduleUpdateValue> {
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      const invalid = validateUpdateArgs(args)
      if (invalid !== undefined) return invalid
      if (exec.signal.aborted) return internalError()
      const id = ScheduleId(args.id)
      try {
        const sessionId = agent.session.id
        const expected = (await ctx.schedule.list({ sessionId }))
          .find(record => record.id === id)
        if (expected === undefined) {
          // The catalog also holds inactive reminders, which is the one not-found
          // case the model can act on: it has to create a new reminder instead.
          const ended = (await ctx.schedule.catalog())
            .some(entry => entry.sessionId === sessionId && entry.id === id)
          return { id, updated: false, code: ended ? 'schedule_ended' : 'schedule_not_found' }
        }
        const change = timingChangeFrom(args)
        const result = await ctx.schedule.update({
          sessionId,
          id,
          expected,
          ...(change === undefined ? {} : { change }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        }, exec.signal)
        return 'record' in result ? scheduleView(result.record, Date.now()) : result
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: args => present('Update reminder', 'other', args.id),
  }))
}
