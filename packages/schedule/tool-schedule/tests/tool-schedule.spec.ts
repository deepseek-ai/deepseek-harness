import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import ScheduleService, {
  DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MAX_TITLE_LENGTH, REQUIRED_TITLE_MESSAGE, ScheduleId, ScheduleInputError,
  createAfterScheduleRecord, formatScheduleLocalTime,
} from '@deepseek-ai/dsh-schedule'
import type { ScheduleCatalogEntry, ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import * as ToolSchedule from '../src/index.ts'
import { agentFor, boundTask, harness, mountToolSchedule, PromptRuntime, seedTasks } from './harness.ts'

const TOOL_NAMES = ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']
const AUTHORIZATION = 'Only create or modify scheduled tasks at the user\'s explicit request; '
  + 'prior explicit user authorization for the running scheduled task remains valid.'
const NOW = '2026-09-16T00:00:00.000Z'
const DAILY = 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY'
const TASK = { title: 'Queue check', prompt: 'Check the queue', rrule: DAILY, target: 'this_session' }
const RECORD_FIELDS = {
  id: ScheduleId('typed-task'), title: 'Typed task', prompt: 'Do the task', scheduledAt: '2026-09-16T01:00:00.000Z',
}
const CALLS = [
  ['schedule_create', TASK],
  ['schedule_list', {}],
  ['schedule_view', { id: 'task-1' }],
  ['schedule_edit', { id: 'task-1', action: 'delete' }],
] as const
const INTERNAL_ERROR = { code: 'internal_error', message: 'The schedule operation failed.' }
const TWO_LINES = { code: 'invalid_rule', message: 'rrule must contain one DTSTART line followed by one RRULE line.' }
const DELETE_ONLY = { code: 'invalid_selector', message: 'delete accepts only id, action, and expectedUpdatedAt.' }
const UPDATE_FIELD = {
  code: 'invalid_selector', message: 'update requires at least one of title, prompt, rrule, target, or active.',
}

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(options: Parameters<typeof harness>[0] = {}, meta?: Parameters<typeof agentFor>[2]) {
  const test = await harness(options); tests.push(test)
  const agent = agentFor(test.ctx, 'original', meta)
  const scope = await mountToolSchedule(test.ctx, agent)
  return { ...test, agent, scope }
}
type Setup = Awaited<ReturnType<typeof setup>>

/** Set up with a preset roster whose composed preset is `research` and a caller Session in `/work`. */
async function setupWithPreset() {
  const composedPreset = vi.fn((_ctx: Context) => 'research')
  const test = await setup({ onContext: ctx => ctx.provide('agentPresets', { composedPreset } as never) }, { cwd: '/work' })
  return { ...test, composedPreset }
}

async function execute(test: Setup, name: string, args: unknown, agent: Agent = test.agent) {
  return await executeToolFixture(test.ctx, {
    callId: ToolCallId('schedule-call'), signal: new AbortController().signal, name, arguments: args, agent,
  })
}

/** Execute one successful dispatch and return its value after checking the model content. */
async function call(test: Setup, name: string, args: unknown) {
  const result = await execute(test, name, args)
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  return result.value
}

async function executeBody(test: Setup, name: string, args: unknown, signal: AbortSignal) {
  const definition = test.ctx.tools.get(name, test.agent)
  if (definition === undefined) throw new Error('missing Schedule tool')
  return await definition.execute(args, {
    callId: ToolCallId('body-call'), rootCallId: ToolCallId('body-call'), token: Symbol('test-body') as ToolExecutionToken,
    name, arguments: args, agent: test.agent, signal, deferContext() {}, concludeTurn() {},
  })
}

/** Expected management fields and the next occurrence in the rule's zone. */
function reported<T extends ScheduleCatalogEntry>(task: T) {
  const { involvedSessionIds: _involved, createdAt: _created, executionActive: _execution,
    deliveryFloorEndsAt: _floor, lastDelivery, ...record } = task
  return {
    ...record, scheduledAtLocal: formatScheduleLocalTime(task, task.scheduledAt),
    ...lastDelivery === undefined ? {} : { lastDelivery: {
      scheduledAt: lastDelivery.scheduledAt, deliveredAt: lastDelivery.deliveredAt, targetSessionId: lastDelivery.targetSessionId,
    } },
  }
}

/** Read one stored task as the tools report it. */
async function stored(test: Setup, id: string) {
  const task = await test.service.view({ id: ScheduleId(id) })
  if ('code' in task) throw new Error('the task is not stored')
  return reported(task)
}

/** Create one task through `schedule_create` and return the stored task as reported, which the tool result must equal. */
async function createTask(test: Setup, args: Record<string, unknown> = {}) {
  const value = await call(test, 'schedule_create', { ...TASK, ...args })
  const task = await stored(test, (value as { id: string }).id)
  expect(value).toEqual(task)
  return task
}

/** Create one task from another Session through the service and return it as the tools report it. */
async function createOther(test: Setup) {
  return reported(await test.service.create({
    title: 'Other session', prompt: 'Check from elsewhere', timing: { kind: 'rrule', rrule: 'DTSTART:20260916T003000Z\nRRULE:FREQ=DAILY' },
    target: { kind: 'session', sessionId: SessionId('other-session') },
  }, SessionId('other-session')))
}

describe('Schedule model tools', () => {
  it('registers the four tools only in the mounting Agent scope', async () => {
    const test = await setup()
    expect(test.ctx.tools.schemas(test.agent).map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    const unrelated = agentFor(test.ctx, 'unrelated')
    for (const name of TOOL_NAMES) {
      expect(test.ctx.tools.get(name)).toBeUndefined()
      expect(test.ctx.tools.get(name, unrelated)).toBeUndefined()
    }
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: test.agent }))).toContain(AUTHORIZATION)
    expect(renderPrompt(await test.ctx.systemPrompt.assemble())).not.toContain(AUTHORIZATION)
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: unrelated }))).not.toContain(AUTHORIZATION)
  })

  it('removes tools and guidance while Schedule is unavailable and restores both with the service', async () => {
    const test = await setup()
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: test.agent }))).toContain(AUTHORIZATION)
    await test.fiber.dispose()
    for (const name of TOOL_NAMES) expect(test.ctx.tools.get(name, test.agent)).toBeUndefined()
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: test.agent }))).not.toContain(AUTHORIZATION)
    const later = agentFor(test.ctx, 'later')
    await mountToolSchedule(test.ctx, later)
    expect(test.ctx.tools.schemas(later)).toEqual([])
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: later }))).not.toContain(AUTHORIZATION)
    await test.ctx.plugin(ScheduleService)
    for (const agent of [test.agent, later]) {
      expect(test.ctx.tools.schemas(agent).map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
      expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: agent })).split(AUTHORIZATION)).toHaveLength(2)
    }
  })

  it('removes scoped guidance with its plugin and registers it once after remounting', async () => {
    const test = await setup()
    await test.scope.dispose()
    expect(test.ctx.tools.schemas(test.agent)).toEqual([])
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: test.agent }))).not.toContain(AUTHORIZATION)
    await mountToolSchedule(test.ctx, test.agent)
    expect(test.ctx.tools.schemas(test.agent).map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: test.agent })).split(AUTHORIZATION)).toHaveLength(2)
  })

  it.each(['native', 'ptc'] as const)('renders one shared authorization instruction in %s mode', async (mode) => {
    const test = await setup()
    if (mode === 'ptc') {
      await test.ctx.plugin(PromptRuntime)
      await test.scope.ctx.plugin(PtcToolExecutor)
    }
    const assembly = await test.ctx.systemPrompt.assemble({ scope: test.agent })
    expect(renderPrompt(assembly).split(AUTHORIZATION)).toHaveLength(2)
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(mode === 'ptc' ? ['run_code'] : TOOL_NAMES)
    for (const tool of test.ctx.tools.schemas(test.agent)) expect(tool.description).not.toContain(AUTHORIZATION)
    if (mode === 'ptc') {
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
      expect(sdk).toContain('schedule_create')
      expect(sdk).toContain('schedule_edit')
      expect(sdk).not.toContain(AUTHORIZATION)
    }
  })

  it.each([
    { allow: ['schedule_create', 'schedule_list', 'schedule_view'], visible: true },
    { allow: ['schedule_edit', 'schedule_list', 'schedule_view'], visible: true },
    { allow: ['schedule_list', 'schedule_view'], visible: false },
  ])('shows shared guidance only with a visible mutation tool: $allow', async ({ allow, visible }) => {
    const test = await setup()
    const agent = agentFor(test.ctx, 'restricted')
    const scope = createScope(test.ctx, agent, { parent: test.agent })
    try {
      const restriction = await scope.ctx.plugin(Object.assign((ctx: Context) => { ctx.tools.restrict({ allow }) },
        { inject: ['tools'] }))
      const assembly = await test.ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.tools.map(tool => tool.name)).toEqual(allow)
      expect(renderPrompt(assembly).split(AUTHORIZATION)).toHaveLength(visible ? 2 : 1)
      expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: test.agent }))).toContain(AUTHORIZATION)
      await restriction.dispose()
      expect(test.ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(TOOL_NAMES)
      expect(renderPrompt(await test.ctx.systemPrompt.assemble({ scope: agent })).split(AUTHORIZATION)).toHaveLength(2)
    } finally {
      await scope.dispose()
    }
  })

  it('refuses every call dispatched without a caller Agent', async () => {
    const test = await harness(); tests.push(test)
    await test.ctx.plugin(ToolSchedule)
    for (const [name, args] of CALLS) {
      const result = await executeToolFixture(test.ctx, {
        callId: ToolCallId('agentless-call'), signal: new AbortController().signal, name, arguments: args,
      })
      expect(result.isError).toBe(false)
      expect(result.value).toEqual(INTERNAL_ERROR)
    }
    expect((await test.service.list({})).total).toBe(0)
  })

  it('refuses every call from a registered delegated child whose scope mounts the tools', async () => {
    const test = await harness(); tests.push(test)
    const child = agentFor(test.ctx, 'delegated-child', { delegationDepth: 1 })
    await test.ctx.agents.register(child)
    await mountToolSchedule(test.ctx, child)
    for (const [name, args] of CALLS) {
      const result = await executeToolFixture(test.ctx, {
        callId: ToolCallId('child-call'), signal: new AbortController().signal, name, arguments: args, agent: child,
      })
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' })
    }
    expect((await test.service.list({})).total).toBe(0)
  })

  it('describes the create parameters for the model', async () => {
    const test = await setup()
    const schema = test.ctx.tools.schemas(test.agent).find(candidate => candidate.name === 'schedule_create')
    expect(schema?.parameters).toMatchObject({
      required: ['title', 'prompt', 'rrule', 'target'],
      properties: {
        title: { type: 'string', description: expect.stringContaining(`Task name of at most ${MAX_TITLE_LENGTH} characters`) as string },
        rrule: {
          type: 'string',
          description: expect.stringContaining('"DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=MONTHLY') as string,
        },
        target: {
          type: 'string',
          enum: ['this_session', 'new_once', 'new'],
          description: expect.stringContaining(
            'new_once delivers to the same new session every time, opened at the first delivery; new opens a different '
            + 'new session for every delivery. New sessions use this session\'s working directory and preset.',
          ) as string,
        },
      },
    })
  })

  it.each(['schedule_create', 'schedule_edit'])('keeps %s authoring guidance RRULE-only', async (name) => {
    const test = await setup()
    const schema = test.ctx.tools.schemas(test.agent).find(candidate => candidate.name === name)
    expect(schema).toBeDefined()
    const authoring = JSON.stringify({ description: schema?.description, parameters: schema?.parameters })
    expect(authoring).toMatch(/\brrule\b/i)
    expect(authoring).not.toMatch(/\bcron\b/i)
    expect(schema?.parameters).toMatchObject({ properties: { rrule: { type: 'string' } } })
  })

  it('keeps the RRULE example copyable as a quoted string in the PTC SDK', async () => {
    const test = await setup()
    await test.ctx.plugin(PromptRuntime)
    await test.scope.ctx.plugin(PtcToolExecutor)
    const assembly = await test.ctx.systemPrompt.assemble({ scope: test.agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    const example = /Example: ("[^"\n]+")/.exec(sdk)?.[1]
    expect(example).toContain('\\nRRULE:')
    const rrule: unknown = JSON.parse(example ?? 'null')
    expect(typeof rrule).toBe('string')
    if (typeof rrule !== 'string') throw new Error('missing RRULE string example')
    expect(rrule).toContain('\nRRULE:')
    expect(await call(test, 'schedule_create', { ...TASK, rrule })).toMatchObject({ kind: 'rrule' })
  })

  it.each([
    { newSessionIntervalSeconds: 900, spacing: ', at most once every 15 minutes' },
    { newSessionIntervalSeconds: 90, spacing: ', at most once every 90 seconds' },
  ])('names the configured spacing of new deliveries in the target description: $newSessionIntervalSeconds s',
    async ({ newSessionIntervalSeconds, spacing }) => {
      const test = await setup({ config: { newSessionIntervalSeconds } })
      const schema = test.ctx.tools.schemas(test.agent).find(candidate => candidate.name === 'schedule_create')
      expect(schema?.parameters).toMatchObject({
        properties: {
          target: {
            description: expect.stringContaining(`new opens a different new session for every delivery${spacing}. New sessions`) as string,
          },
        },
      })
    })

  it('creates a task for this Session from trimmed text', async () => {
    const test = await setup()
    expect(await createTask(test, { title: '  Queue check  ', prompt: ' Check the queue\n' })).toEqual({ kind: 'rrule',
      id: expect.stringMatching(/^schedule-/) as string, title: 'Queue check', prompt: 'Check the queue', rrule: DAILY,
      scheduledAt: '2026-09-16T01:00:00.000Z', scheduledAtLocal: '2026-09-16T01:00:00+00:00',
      target: { kind: 'session', sessionId: 'original' },
      status: 'active', updatedAt: NOW,
    })
    expect(test.createSession).not.toHaveBeenCalled()
  })

  it('reserves one new Session with the caller directory and composed preset for new_once', async () => {
    const test = await setupWithPreset()
    const task = await createTask(test, { target: 'new_once' })
    expect(task).toMatchObject({
      target: { kind: 'new_once', sessionId: expect.stringMatching(/^session-/) as string, create: { cwd: '/work', agentPreset: 'research' } },
    })
    expect(test.composedPreset).toHaveBeenCalledOnce()
    expect(test.composedPreset.mock.calls[0]?.[0]).toBe(test.agent.ctx)
    expect(test.createSession).not.toHaveBeenCalled()
  })

  it('preserves an omitted target and replaces an explicit target with the editing Session context', async () => {
    const test = await setupWithPreset()
    const task = await createTask(test, { target: 'new_once' })
    if (task.target.kind !== 'new_once') throw new Error('expected a reserved Session target')
    const editor = agentFor(test.ctx, 'editor', { cwd: '/other' })
    await mountToolSchedule(test.ctx, editor)
    test.composedPreset.mockReturnValue('editor-preset')
    const renamed = await execute(test, 'schedule_edit', { id: task.id, action: 'update', title: 'Renamed' }, editor)
    expect(renamed.value).toMatchObject({ target: task.target })
    const replaced = await execute(test, 'schedule_edit', { id: task.id, action: 'update', target: 'new_once' }, editor)
    expect(replaced.value).toMatchObject({
      target: { kind: 'new_once', create: { cwd: '/other', agentPreset: 'editor-preset' } },
    })
    expect(replaced.value).not.toHaveProperty('target.sessionId', task.target.sessionId)
    expect(test.createSession).not.toHaveBeenCalled()
  })

  it('targets a new Session per delivery for new, omitting creation values the caller lacks', async () => {
    const test = await setupWithPreset()
    const task = await createTask(test, { target: 'new' })
    expect(task.target).toEqual({ kind: 'new', create: { cwd: '/work', agentPreset: 'research' } })
    const bare = await createTask(await setup(), { target: 'new' })
    expect(bare.target).toEqual({ kind: 'new', create: {} })
  })

  it.each([
    { input: 'a blank title', args: { title: ' ' }, error: { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE } },
    {
      input: 'a long title', args: { title: 'x'.repeat(MAX_TITLE_LENGTH + 1) },
      error: { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` },
    },
    {
      input: 'a blank prompt', args: { prompt: '\n' },
      error: { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' },
    },
    { input: 'a rule without DTSTART', args: { rrule: 'RRULE:FREQ=DAILY' }, error: TWO_LINES },
    { input: 'an escaped newline', args: { rrule: 'DTSTART:20260916T010000Z\\nRRULE:FREQ=DAILY' }, error: TWO_LINES },
    {
      input: 'an unknown time zone', args: { rrule: 'DTSTART;TZID=Mars/Olympus:20260916T080000\nRRULE:FREQ=DAILY' },
      error: { code: 'invalid_time_zone', message: 'TZID must be UTC or a valid IANA Area/Location name.' },
    },
    {
      input: 'FREQ=SECONDLY', args: { rrule: 'DTSTART:20260916T010000Z\nRRULE:FREQ=SECONDLY' },
      error: {
        code: 'frequency_too_high', message: 'FREQ=SECONDLY is not supported; occurrences must be at least 60 seconds apart.',
      },
    },
    {
      input: 'a rule that ended', args: { rrule: 'DTSTART:20260901T010000Z\nRRULE:FREQ=DAILY;UNTIL=20260910T000000Z' },
      error: { code: 'not_future', message: 'rrule must contain an occurrence strictly in the future.' },
    },
  ])('returns the input error for $input and stores nothing', async ({ args, error }) => {
    const test = await setup()
    expect(await call(test, 'schedule_create', { ...TASK, ...args })).toEqual(error)
    expect((await test.service.list({})).total).toBe(0)
  })

  it('rejects a target outside the model choices before the service runs', async () => {
    const test = await setup()
    const create = vi.spyOn(test.service, 'create')
    expect((await execute(test, 'schedule_create', { ...TASK, target: 'session' })).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('lists one page of tasks from every Session', async () => {
    const test = await setup()
    const other = await createOther(test)
    const first = await createTask(test)
    const second = await createTask(test, { rrule: 'DTSTART:20260916T020000Z\nRRULE:FREQ=DAILY' })
    const paused = await call(test, 'schedule_edit', { id: (await createTask(test)).id, action: 'update', active: false })
    expect(await call(test, 'schedule_list', {})).toEqual({
      items: [other, first, second, paused], shown: 4, total: 4, limit: DEFAULT_LIST_LIMIT, offset: 0,
    })
    expect(await call(test, 'schedule_list', { limit: 1, offset: 1 }))
      .toEqual({ items: [first], shown: 1, total: 4, limit: 1, offset: 1 })
    expect(await call(test, 'schedule_list', { active: true })).toMatchObject({ items: [other, first, second], total: 3 })
    expect(await call(test, 'schedule_list', { active: false })).toMatchObject({ items: [paused], total: 1 })
    // An undeclared argument does not select a narrower list.
    expect(await call(test, 'schedule_list', { sessionId: 'original' })).toMatchObject({ total: 4 })
  })

  it.each([{ limit: 0 }, { limit: MAX_LIST_LIMIT + 1 }, { offset: -1 }])('rejects the page bounds %j', async (bounds) => {
    const test = await setup()
    expect(await call(test, 'schedule_list', bounds)).toEqual({
      code: 'invalid_rule', message: `limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer.`,
    })
  })

  it('views one task by id and reports a missing id', async () => {
    const test = await setup()
    const task = await createTask(test)
    expect(await call(test, 'schedule_view', { id: task.id })).toEqual(task)
    expect(await call(test, 'schedule_view', { id: 'missing' })).toEqual({ id: 'missing', code: 'schedule_not_found' })
  })

  it('views the latest delivery of a task', async () => {
    const test = await setup()
    test.resolve.mockResolvedValue({ agent: test.agent })
    const task = await createTask(test)
    await test.service.run({ id: task.id })
    const viewed = await call(test, 'schedule_view', { id: task.id })
    expect(viewed).toEqual(await stored(test, task.id))
    expect(viewed).toMatchObject({ lastDelivery: { targetSessionId: 'original', deliveredAt: NOW } })
    for (const key of ['involvedSessionIds', 'createdAt', 'executionActive', 'deliveryFloorEndsAt', 'lastDelivery.messageId']) {
      expect(viewed).not.toHaveProperty(key)
    }
  })

  it('updates every field in one change', async () => {
    const test = await setup()
    const task = await createTask(test)
    const rrule = 'DTSTART;TZID=Asia/Singapore:20260921T080000\nRRULE:FREQ=WEEKLY;BYDAY=MO'
    const updated = await call(test, 'schedule_edit', { kind: 'rrule',
      id: task.id, action: 'update', title: 'Weekly check', prompt: 'Check the weekly queue', rrule, target: 'new',
      active: false, expectedUpdatedAt: task.updatedAt,
    })
    expect(updated).toEqual({ ...task, title: 'Weekly check', prompt: 'Check the weekly queue', rrule, scheduledAt: '2026-09-21T00:00:00.000Z',
      scheduledAtLocal: '2026-09-21T08:00:00+08:00', target: { kind: 'new', create: {} }, status: 'paused',
      updatedAt: '2026-09-16T00:00:00.001Z',
    })
    expect(await stored(test, task.id)).toEqual(updated)
  })

  it('pauses a task and resumes it at the next future occurrence', async () => {
    const test = await setup()
    const task = await createTask(test)
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'update', active: false }))
      .toMatchObject({ status: 'paused', scheduledAt: '2026-09-16T01:00:00.000Z' })
    vi.setSystemTime(new Date('2026-09-17T12:00:00Z'))
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'update', active: true })).toMatchObject({
      status: 'active', scheduledAt: '2026-09-18T01:00:00.000Z', updatedAt: '2026-09-17T12:00:00.000Z',
    })
  })

  it('applies a change based on the latest read and refuses a change based on an earlier read', async () => {
    const test = await setup()
    const task = await createTask(test)
    const renamed = await call(test, 'schedule_edit', {
      id: task.id, action: 'update', title: 'Renamed', expectedUpdatedAt: task.updatedAt,
    })
    expect(renamed).toMatchObject({ title: 'Renamed', updatedAt: '2026-09-16T00:00:00.001Z' })
    expect(await call(test, 'schedule_edit', {
      id: task.id, action: 'update', title: 'Stale', expectedUpdatedAt: task.updatedAt,
    })).toEqual({ id: task.id, code: 'schedule_conflict' })
    expect(await stored(test, task.id)).toEqual(renamed)
  })

  it('deletes a task only when it is unchanged since the read named by expectedUpdatedAt', async () => {
    const test = await setup()
    const task = await createTask(test)
    const renamed = await call(test, 'schedule_edit', { id: task.id, action: 'update', title: 'Renamed' })
    expect(renamed).toMatchObject({ updatedAt: '2026-09-16T00:00:00.001Z' })
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'delete', expectedUpdatedAt: task.updatedAt }))
      .toEqual({ id: task.id, code: 'schedule_conflict' })
    expect(await stored(test, task.id)).toEqual(renamed)
    expect(await call(test, 'schedule_edit', {
      id: task.id, action: 'delete', expectedUpdatedAt: '2026-09-16T00:00:00.001Z',
    })).toEqual({ id: task.id, deleted: true })
  })

  it('deletes a task, after which its id is missing', async () => {
    const test = await setup()
    const task = await createTask(test)
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'delete' })).toEqual({ id: task.id, deleted: true })
    const missing = { id: task.id, code: 'schedule_not_found' }
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'delete' })).toEqual(missing)
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'update', title: 'Gone' })).toEqual(missing)
    expect(await call(test, 'schedule_view', { id: task.id })).toEqual(missing)
  })

  it.each([
    { input: 'delete with a title', args: { action: 'delete', title: 'Renamed' }, error: DELETE_ONLY },
    { input: 'delete with a pause', args: { action: 'delete', active: false }, error: DELETE_ONLY },
    { input: 'an empty update', args: { action: 'update' }, error: UPDATE_FIELD },
    { input: 'an update with only a read time', args: { action: 'update', expectedUpdatedAt: NOW }, error: UPDATE_FIELD },
    {
      input: 'a blank title', args: { action: 'update', title: ' ' },
      error: { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE },
    },
    { input: 'a one-line rrule', args: { action: 'update', rrule: 'RRULE:FREQ=DAILY' }, error: TWO_LINES },
  ])('returns the input error for $input and keeps the task', async ({ args, error }) => {
    const test = await setup()
    const task = await createTask(test)
    expect(await call(test, 'schedule_edit', { id: task.id, ...args })).toEqual(error)
    expect(await stored(test, task.id)).toEqual(task)
  })

  it('requires a future RRULE to resume an ended one-shot task', async () => {
    const id = ScheduleId('ended-task')
    const rule = createAfterScheduleRecord(id, 'Ended prompt', 1, Date.parse('2026-09-15T00:00:00.000Z'), 'Ended')
    const test = await setup({
      beforeService: (_ctx, facility) => seedTasks(facility, [boundTask(SessionId('original'), rule, { status: 'ended' })]),
    })
    expect(await call(test, 'schedule_view', { id })).toMatchObject({
      status: 'ended', kind: 'after', scheduledAt: '2026-09-15T00:00:01.000Z',
    })
    expect(await call(test, 'schedule_edit', { id, action: 'update', active: true })).toEqual({
      code: 'not_future', message: 'This task has no future occurrence. Set a future schedule before resuming it.',
    })
    const resumed = await call(test, 'schedule_edit', { id, action: 'update', rrule: DAILY, active: true })
    expect(resumed).toMatchObject({ kind: 'rrule', status: 'active', rrule: DAILY, scheduledAt: '2026-09-16T01:00:00.000Z' })
  })

  it.each([
    { ...RECORD_FIELDS, kind: 'rrule', rrule: DAILY },
    { ...RECORD_FIELDS, kind: 'cron', expression: '0 1 * * *', timeZone: 'UTC' },
    { ...RECORD_FIELDS, kind: 'every', everySeconds: 60 },
    { ...RECORD_FIELDS, kind: 'after', afterSeconds: 3600 },
    { ...RECORD_FIELDS, kind: 'at' },
    { ...RECORD_FIELDS, kind: 'daily', time: '01:00:00.000', timeZone: 'UTC' },
    { ...RECORD_FIELDS, kind: 'weekly', time: '01:00:00.000', timeZone: 'UTC', weekdays: [3] },
  ] satisfies ScheduleRecord[])(
    'returns authoritative $kind timing fields in view, list, and edit', async (rule) => {
      const { id } = rule
      const test = await setup({ beforeService: (_ctx, facility) => seedTasks(facility, [boundTask(SessionId('original'), rule)]) })
      expect(await test.service.view({ id })).toMatchObject(rule)
      expect(await call(test, 'schedule_view', { id })).toMatchObject(rule)
      expect(await call(test, 'schedule_list', {})).toMatchObject({ items: [rule] })
      expect(await call(test, 'schedule_edit', { id, action: 'update', title: 'Renamed' })).toMatchObject({ ...rule, title: 'Renamed' })
    })

  it('changes another Session task and keeps notification bookkeeping out of the model result', async () => {
    const test = await setup()
    const other = await createOther(test)
    const edited = await call(test, 'schedule_edit', { id: other.id, action: 'update', title: 'Renamed here' })
    expect(edited).toMatchObject({
      title: 'Renamed here', target: { kind: 'session', sessionId: 'other-session' },
    })
    expect(edited).not.toHaveProperty('involvedSessionIds')
    expect(await test.service.view({ id: other.id })).toMatchObject({
      involvedSessionIds: ['other-session', 'original'],
    })
  })

  it('withholds failures that the tool does not declare', async () => {
    const test = await setup()
    vi.spyOn(test.service, 'list').mockRejectedValueOnce(new ScheduleInputError('not_future', 'private detail'))
    expect(await call(test, 'schedule_list', {})).toEqual(INTERNAL_ERROR)
    vi.spyOn(test.service, 'view').mockRejectedValueOnce(new Error('private backend location'))
    expect(await call(test, 'schedule_view', { id: 'task-1' })).toEqual(INTERNAL_ERROR)
  })

  it('withholds storage failures and keeps the stored tasks', async () => {
    const test = await setup()
    const task = await createTask(test)
    test.pool.failNextWrites = 1
    expect(await call(test, 'schedule_create', { ...TASK, title: 'Lost' })).toEqual(INTERNAL_ERROR)
    test.pool.failNextWrites = 1
    expect(await call(test, 'schedule_edit', { id: task.id, action: 'update', title: 'Renamed' })).toEqual(INTERNAL_ERROR)
    expect((await test.service.list({})).items.map(reported)).toEqual([task])
  })

  it('changes nothing when the call is already canceled', async () => {
    const test = await setup()
    const task = await createTask(test)
    expect(await executeBody(test, 'schedule_create', TASK, AbortSignal.abort())).toEqual(INTERNAL_ERROR)
    expect(await executeBody(test, 'schedule_edit', { id: task.id, action: 'update', title: 'Canceled' }, AbortSignal.abort()))
      .toEqual(INTERNAL_ERROR)
    expect((await test.service.list({})).items.map(reported)).toEqual([task])
  })

  it('presents each call as a generic card', async () => {
    const test = await setup()
    const cases = [
      ['schedule_create', TASK, { card: 'generic', title: 'Create scheduled task', kind: 'other', rawInput: 'Queue check' }],
      ['schedule_list', {}, { card: 'generic', title: 'List scheduled tasks', kind: 'read' }],
      ['schedule_view', { id: 'task-1' }, { card: 'generic', title: 'View scheduled task', kind: 'read', rawInput: 'task-1' }],
      ['schedule_edit', { id: 'task-1', action: 'update', title: 'Renamed' },
        { card: 'generic', title: 'Edit scheduled task', kind: 'other', rawInput: 'task-1' }],
      ['schedule_edit', { id: 'task-1', action: 'delete' },
        { card: 'generic', title: 'Delete scheduled task', kind: 'other', rawInput: 'task-1' }],
    ] as const
    for (const [name, args, presentation] of cases) {
      expect(test.ctx.tools.get(name, test.agent)?.presentCall?.(args)).toEqual(presentation)
    }
    expect(test.ctx.tools.get('schedule_create', test.agent)?.presentCall?.({ ...TASK, title: 42 })).toBeUndefined()
  })

  it('unregisters every tool when the mounting scope is disposed', async () => {
    const test = await setup()
    await test.scope.dispose()
    for (const name of TOOL_NAMES) expect(test.ctx.tools.get(name, test.agent)).toBeUndefined()
    expect((await execute(test, 'schedule_list', {})).isError).toBe(true)
  })
})
