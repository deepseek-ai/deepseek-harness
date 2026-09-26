import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { registerScheduleTools } from '../src/tools.ts'
import { MAX_TITLE_LENGTH, REQUIRED_TITLE_MESSAGE, ScheduleId, createAfterScheduleRecord } from '../src/domain.ts'
import { scheduleDomain } from '../src/storage.ts'
import { harness, agentFor } from './harness.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const test = await harness(options); tests.push(test)
  const agent = agentFor(test.ctx)
  test.ctx.effect(() => test.ctx.agents.enter(agent, undefined))
  const dispose = registerScheduleTools(test.ctx, test.ctx, agent)
  return { ...test, agent, dispose }
}
async function execute(test: Awaited<ReturnType<typeof setup>>, name: string, args: unknown, agent: Agent = test.agent) {
  return await test.ctx.agents.withInitiator(agent, () => test.ctx.tools.execute({
    callId: ToolCallId('schedule-call'), signal: new AbortController().signal, name, arguments: args, agent,
  }))
}

async function executeBody(test: Awaited<ReturnType<typeof setup>>, name: string, args: unknown, signal: AbortSignal) {
  const definition = test.ctx.tools.get(name)
  if (definition === undefined) throw new Error('missing Schedule tool')
  return await definition.execute(args, {
    callId: ToolCallId('body-call'), rootCallId: ToolCallId('body-call'), token: Symbol('test-body') as ToolExecutionToken,
    name, arguments: args, agent: test.agent, signal, deferContext() {}, concludeTurn() {},
  })
}

describe('Schedule model tools', () => {
  it('creates and lists a lossless daily JSON rule rather than a one-shot', async () => {
    const test = await setup()
    const created = await execute(test, 'schedule_create', {
      prompt: '  Daily\n"quoted"  ', title: 'Daily', daily: { time: '23:00:00.12', time_zone: 'Asia/Shanghai' },
    })
    expect(created.isError).toBe(false)
    const records = await test.service.list({ sessionId: test.agent.session.id })
    expect(records).toHaveLength(1)
    expect(created.value).toEqual({
      id: records[0]!.id, kind: 'daily', title: 'Daily', prompt: 'Daily\n"quoted"', time: '23:00:00.120',
      timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T15:00:00.120Z', state: 'scheduled', deliveryMode: 'host',
    })
    expect(created.content).toEqual([{ type: 'text', text: JSON.stringify(created.value) }])
    const listed = await execute(test, 'schedule_list', {})
    expect(listed.isError).toBe(false)
    expect(listed.value).toEqual([created.value])
    expect(listed.content).toEqual([{ type: 'text', text: JSON.stringify([created.value]) }])
    expect(await test.service.catalog()).toEqual([{ ...records[0], sessionId: test.agent.session.id, status: 'active' }])
    expect(test.resolve).not.toHaveBeenCalled()
  })

  it('creates a weekly JSON rule with normalized weekdays and a distinct next target', async () => {
    const test = await setup()
    const created = await execute(test, 'schedule_create', {
      prompt: '  Weekly\n"quoted"  ', title: 'Weekly',
      weekly: { time: '09:00:00.12', time_zone: 'Asia/Shanghai', weekdays: [3, 1] },
    })
    expect(created.isError).toBe(false)
    const records = await test.service.list({ sessionId: test.agent.session.id })
    expect(records).toHaveLength(1)
    expect(created.value).toEqual({
      id: records[0]!.id, kind: 'weekly', title: 'Weekly', prompt: 'Weekly\n"quoted"', time: '09:00:00.120',
      timeZone: 'Asia/Shanghai', weekdays: [1, 3], scheduledAt: '2026-09-16T01:00:00.120Z',
      state: 'scheduled', deliveryMode: 'host',
    })
    expect(created.content).toEqual([{ type: 'text', text: JSON.stringify(created.value) }])
    const listed = await execute(test, 'schedule_list', {})
    expect(listed.value).toEqual([created.value])
    expect(await test.service.catalog()).toEqual([{ ...records[0], sessionId: test.agent.session.id, status: 'active' }])
    expect(test.resolve).not.toHaveBeenCalled()
  })

  it('accepts a supplied title in the tool schema and returns it in the create and list views', async () => {
    const test = await setup()
    const schema = test.ctx.tools.schemas(test.agent).find(item => item.name === 'schedule_create')
    const parameters = schema?.parameters as { properties: Record<string, { type?: string; description?: string }>; required: string[] }
    expect(parameters.properties.title?.type).toBe('string')
    expect(parameters.properties.title?.description).toContain('task card')
    expect(parameters.required).toEqual(expect.arrayContaining(['prompt', 'title']))
    const created = await execute(test, 'schedule_create', {
      prompt: 'Check the queue\nand the backlog', title: '  Queue check  ', every_seconds: 300,
    })
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ title: 'Queue check', prompt: 'Check the queue\nand the backlog' })
    expect((await execute(test, 'schedule_list', {})).value).toMatchObject([{ title: 'Queue check' }])
  })

  it('rejects a missing title in the create tool before storing a task', async () => {
    const test = await setup()
    const result = await execute(test, 'schedule_create', { prompt: 'Keep', after_seconds: 60 })
    expect(result.isError).toBe(true)
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    ['   ', REQUIRED_TITLE_MESSAGE],
    ['x'.repeat(MAX_TITLE_LENGTH + 1), `title must be at most ${MAX_TITLE_LENGTH} characters.`],
  ])('refuses the invalid title %j before storing a task', async (title, message) => {
    const test = await setup()
    const result = await execute(test, 'schedule_create', { prompt: 'Keep', after_seconds: 60, title })
    expect(result.value).toEqual({ code: 'invalid_prompt', message })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    [undefined, REQUIRED_TITLE_MESSAGE],
    ['   ', REQUIRED_TITLE_MESSAGE],
    [`${'x'.repeat(MAX_TITLE_LENGTH)}y`, `title must be at most ${MAX_TITLE_LENGTH} characters.`],
  ])('rejects a missing, blank, or over-long title at the shared service', async (title, message) => {
    const test = await setup()
    await expect(test.service.create(test.agent.session.id, {
      prompt: 'Keep', after_seconds: 60, title: title as string,
    })).rejects.toMatchObject({ code: 'invalid_prompt', message })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    ['empty set', []], ['out-of-range weekday', [0]], ['weekday above Sunday', [8]], ['duplicate weekday', [2, 2]],
  ])('refuses a %s before storing a weekly task', async (_label, weekdays) => {
    const test = await setup()
    const result = await execute(test, 'schedule_create', {
      prompt: 'Invalid weekdays', title: 'Invalid weekdays',
      weekly: { time: '09:00:00', time_zone: 'UTC', weekdays },
    })
    expect(result.value).toMatchObject({ code: 'invalid_rule' })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    ['non-integer weekday', [1.5]], ['string weekday', ['1']], ['null weekday', [null]],
  ])('rejects a %s at the tool parameter schema', async (_label, weekdays) => {
    const test = await setup()
    const result = await execute(test, 'schedule_create', {
      prompt: 'Invalid weekdays', title: 'Invalid weekdays',
      weekly: { time: '09:00:00', time_zone: 'UTC', weekdays },
    })
    expect(result.isError).toBe(true)
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    null, '09:00:00', {}, { time: '09:00:00' }, { time: '09:00:00', time_zone: 'UTC' },
    { time: '09:00:00', weekdays: [1] }, { time: 9, time_zone: 'UTC', weekdays: [1] },
    { time: '09:00:00', time_zone: 8, weekdays: [1] },
    { time: '09:00:00', time_zone: 'UTC', weekdays: [1], date: '2026-09-16' },
  ])('rejects malformed weekly JSON arguments %# before creation', async (weekly) => {
    const test = await setup()
    expect((await execute(test, 'schedule_create', { prompt: 'Malformed', title: 'Malformed', weekly })).isError).toBe(true)
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it('creates a cron JSON rule with a canonical expression and a distinct next target', async () => {
    const test = await setup()
    const created = await execute(test, 'schedule_create', {
      prompt: '  Cron\n"quoted"  ', title: 'Cron',
      cron: { expression: '00 09 * * 5,4,3,2,1', time_zone: 'Asia/Shanghai' },
    })
    expect(created.isError).toBe(false)
    const records = await test.service.list({ sessionId: test.agent.session.id })
    expect(records).toHaveLength(1)
    expect(created.value).toEqual({
      id: records[0]!.id, kind: 'cron', title: 'Cron', prompt: 'Cron\n"quoted"', expression: '0 9 * * 1-5',
      timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T01:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
    })
    expect(created.content).toEqual([{ type: 'text', text: JSON.stringify(created.value) }])
    expect((await execute(test, 'schedule_list', {})).value).toEqual([created.value])
    expect(await test.service.catalog()).toEqual([{ ...records[0], sessionId: test.agent.session.id, status: 'active' }])
    expect(test.resolve).not.toHaveBeenCalled()
  })

  it('exposes the cron selector in the create tool schema', async () => {
    const test = await setup()
    const schema = test.ctx.tools.schemas(test.agent).find(item => item.name === 'schedule_create')
    expect(schema?.description).toContain('cron')
    expect(schema?.parameters).toMatchObject({
      properties: {
        cron: {
          type: 'object',
          additionalProperties: false,
          properties: { expression: { type: 'string' }, time_zone: { type: 'string' } },
        },
      },
    })
  })

  it.each<[unknown, string]>([
    [{ expression: '0 0 L * *', time_zone: 'UTC' }, 'invalid_rule'],
    [{ expression: '0 0 20-10 * *', time_zone: 'UTC' }, 'invalid_rule'],
    [{ expression: '0 0 * * *', time_zone: '+08:00' }, 'invalid_time_zone'],
    [{ expression: '0 0 30 2 *', time_zone: 'UTC' }, 'time_out_of_range'],
  ])('refuses the invalid cron rule %# before storing a task', async (cron, code) => {
    const test = await setup()
    expect((await execute(test, 'schedule_create', { prompt: 'Invalid cron', title: 'Invalid cron', cron })).value)
      .toMatchObject({ code })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    null, '0 0 * * *', {}, { expression: '0 0 * * *' }, { time_zone: 'UTC' },
    { expression: 7, time_zone: 'UTC' }, { expression: '0 0 * * *', time_zone: 8 },
    { expression: '0 0 * * *', time_zone: 'UTC', extra: true },
  ])('rejects malformed cron JSON arguments %# before creation', async (cron) => {
    const test = await setup()
    expect((await execute(test, 'schedule_create', { prompt: 'Malformed', title: 'Malformed', cron })).isError).toBe(true)
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it('requires exactly one of all six selectors for every selector combination', async () => {
    const test = await setup()
    const selectors = [
      { after_seconds: 60 }, { at: '2026-09-17T00:00:00Z' }, { every_seconds: 300 },
      { daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } },
      { weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } },
      { cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' } },
    ]
    for (let mask = 0; mask < 64; mask += 1) {
      if (mask !== 0 && (mask & (mask - 1)) === 0) continue
      const args = selectors.filter((_selector, index) => mask & (1 << index))
        .reduce<Record<string, unknown>>((input, selector) => ({ ...input, ...selector }), {
          prompt: 'Invalid selection', title: 'Invalid selection',
        })
      expect((await execute(test, 'schedule_create', args)).value).toEqual({
        code: 'invalid_selector',
        message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.',
      })
    }
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    ['24:00:00', 'UTC', 'invalid_rule'], ['23:59:60', 'UTC', 'invalid_rule'],
    ['23:00', 'UTC', 'invalid_rule'], ['23:00:00.1234', 'UTC', 'invalid_rule'],
    ['23:00:00', 'Unknown/Zone', 'invalid_time_zone'], ['23:00:00', '+08:00', 'invalid_time_zone'],
  ])('rejects invalid daily rule values (%s, %s)', async (time, time_zone, code) => {
    const test = await setup()
    expect((await execute(test, 'schedule_create', {
      prompt: 'Invalid rule', title: 'Invalid rule', daily: { time, time_zone },
    })).value)
      .toMatchObject({ code })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    null, '23:00:00', {}, { time: '23:00:00' }, { time: 23, time_zone: 'UTC' },
    { time: '23:00:00', time_zone: 8 }, { time: '23:00:00', time_zone: 'UTC', date: '2026-09-16' },
  ])('rejects malformed daily JSON arguments %# before creation', async (daily) => {
    const test = await setup()
    expect((await execute(test, 'schedule_create', { prompt: 'Malformed', title: 'Malformed', daily })).isError).toBe(true)
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it('creates through the shared service and exposes the same list and delete values', async () => {
    const test = await setup()
    const created = await execute(test, 'schedule_create', { prompt: 'Check', every_seconds: 300, title: 'Check' })
    const records = await test.service.list({ sessionId: test.agent.session.id })
    expect(records).toHaveLength(1)
    expect(created.value).toMatchObject({ id: records[0]?.id, kind: 'every', deliveryMode: 'host' })
    const listed = await execute(test, 'schedule_list', {})
    expect(listed.value).toEqual([created.value])
    const deleted = await execute(test, 'schedule_delete', { id: records[0]?.id })
    expect(deleted.value).toEqual({ id: records[0]?.id, deleted: true })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    { prompt: 'Missing selector', title: 'Missing selector' },
    { prompt: 'Conflicting', after_seconds: 1, every_seconds: 300, title: 'Conflicting' },
    { prompt: 'Too frequent', every_seconds: 1, title: 'Too frequent' },
    { prompt: ' ', after_seconds: 1, title: 'Blank prompt' },
    { prompt: 'Past', at: '2026-09-15T00:00:00Z', title: 'Past' },
    { prompt: 'Unknown selector', after_seconds: 60, extra: true, title: 'Unknown selector' },
    { prompt: 'Fractional delay', after_seconds: 1.5, title: 'Fractional delay' },
    { prompt: 'Zero delay', after_seconds: 0, title: 'Zero delay' },
    { prompt: 'Negative delay', after_seconds: -1, title: 'Negative delay' },
    { prompt: 'Fractional interval', every_seconds: 300.5, title: 'Fractional interval' },
  ])('refuses invalid creation input %j without storing a task', async (args) => {
    const test = await setup()
    const result = await execute(test, 'schedule_create', args)
    expect(result.value).toHaveProperty('code')
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it('cannot use a tool bound to another Agent or delete another Session task', async () => {
    const test = await setup()
    const foreign = agentFor(test.ctx, 'foreign')
    const record = await test.service.create(SessionId('foreign'), {
      prompt: 'Keep', after_seconds: 60, title: 'Keep',
    })
    expect((await execute(test, 'schedule_list', {}, foreign)).value).toMatchObject({ code: 'internal_error' })
    expect((await execute(test, 'schedule_delete', { id: record.id })).value)
      .toMatchObject({ deleted: false, code: 'schedule_not_found' })
    expect(await test.service.list({ sessionId: foreign.session.id })).toEqual([record])
  })

  it('contains storage failure and unregisters all tools on disposal', async () => {
    const test = await setup()
    test.pool.failNextWrites = 1
    expect((await execute(test, 'schedule_create', { prompt: 'Failed', after_seconds: 60, title: 'Failed' })).value)
      .toMatchObject({ code: 'internal_error' })
    test.dispose()
    test.dispose()
    expect((await execute(test, 'schedule_list', {})).isError).toBe(true)
  })

  it('presents management calls and renders lossless model results', async () => {
    const test = await setup()
    const cases = [
      ['schedule_create', { prompt: 'Check', after_seconds: 60, title: 'Check' },
        { card: 'generic', title: 'Create reminder', kind: 'other', rawInput: 'Check' }],
      ['schedule_list', {}, { card: 'generic', title: 'List reminders', kind: 'read' }],
      ['schedule_delete', { id: 'missing' },
        { card: 'generic', title: 'Delete reminder', kind: 'other', rawInput: 'missing' }],
      ['schedule_update', { id: 'missing', title: 'Check' },
        { card: 'generic', title: 'Update reminder', kind: 'other', rawInput: 'missing' }],
    ] as const
    for (const [name, args, presentation] of cases) {
      const definition = test.ctx.tools.get(name)
      expect(definition?.presentCall?.(args)).toEqual(presentation)
      const result = await execute(test, name, args)
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    }
    expect(test.ctx.tools.get('schedule_create')?.presentCall?.({ prompt: 42 })).toBeUndefined()
  })

  it.each(['', ' padded', 'padded '])('rejects a malformed delete identity %j', async (id) => {
    const test = await setup()
    expect((await execute(test, 'schedule_delete', { id })).value)
      .toMatchObject({ code: 'invalid_rule' })
  })

  it.each([
    ['schedule_create', { prompt: 'Foreign', after_seconds: 60, title: 'Foreign' }],
    ['schedule_delete', { id: 'foreign-task' }],
  ])('rejects another Agent using %s', async (name, args) => {
    const test = await setup()
    const foreign = agentFor(test.ctx, 'other-tool-caller')
    expect((await execute(test, name, args, foreign)).value).toMatchObject({ code: 'internal_error' })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([])
  })

  it.each([
    ['schedule_create', { prompt: 'Canceled', after_seconds: 60, title: 'Canceled' }],
    ['schedule_list', {}],
    ['schedule_delete', { id: 'canceled-task' }],
  ])('refuses cancellation at the %s body before calling the service', async (name, args) => {
    const test = await setup()
    const create = vi.spyOn(test.service, 'create')
    const list = vi.spyOn(test.service, 'list')
    const remove = vi.spyOn(test.service, 'delete')
    // The runtime rejects an already-aborted caller before invoking its registered body.
    const value = await executeBody(test, name, args, AbortSignal.abort())
    expect(value).toMatchObject({ code: 'internal_error' })
    expect(create).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it.each(['schedule_create', 'schedule_delete'])('does not mutate tasks when %s is canceled in the FIFO', async (name) => {
    const test = await setup()
    const sessionId = test.agent.session.id
    const target = await test.service.create(sessionId, { prompt: 'Keep target', after_seconds: 300, title: 'Keep target' })
    await test.service.create(sessionId, { prompt: 'Queue blocker', after_seconds: 1, title: 'Queue blocker' })
    const entered = Promise.withResolvers<undefined>()
    const restored = Promise.withResolvers<{ agent: Agent }>()
    test.resolve.mockImplementationOnce(() => { entered.resolve(undefined); return restored.promise })
    const controller = new AbortController()
    try {
      await vi.advanceTimersByTimeAsync(1000)
      await entered.promise
      const args = name === 'schedule_create'
        ? { prompt: 'Canceled in queue', after_seconds: 60, title: 'Canceled in queue' }
        : { id: target.id }
      const pending = executeBody(test, name, args, controller.signal)
      controller.abort()
      restored.resolve({ agent: test.agent })
      const result = await pending
      expect(await test.service.list({ sessionId })).toEqual([target])
      expect(result).toMatchObject({ code: 'internal_error' })
    } finally {
      restored.resolve({ agent: test.agent })
    }
  })

  it('withholds storage details from list and delete failures and retains the task', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', after_seconds: 60, title: 'Keep',
    })
    vi.spyOn(test.service, 'list').mockRejectedValueOnce(new Error('private backend location'))
    expect((await execute(test, 'schedule_list', {})).value)
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    test.pool.failNextWrites = 1
    expect((await execute(test, 'schedule_delete', { id: record.id })).value)
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([record])
  })

  it.each([
    ['at', { at: '2026-09-16T01:00:00Z' }, 'at'],
    ['every_seconds', { every_seconds: 600 }, 'every'],
    ['daily', { daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } }, 'daily'],
    ['weekly', { weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } }, 'weekly'],
    ['cron', { cron: { expression: '*/15 * * * *', time_zone: 'UTC' } }, 'cron'],
  ])('retimes one reminder through %s in place', async (_label, selector, kind) => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', every_seconds: 300, title: 'Keep',
    })
    const updated = await execute(test, 'schedule_update', { id: record.id, ...selector })
    expect(updated.isError).toBe(false)
    expect(updated.value).toMatchObject({ id: record.id, kind, title: 'Keep' })
    const records = await test.service.list({ sessionId: test.agent.session.id })
    expect(records).toHaveLength(1)
    expect(records[0]!.id).toBe(record.id)
    expect(records[0]!.scheduledAt).toBe((updated.value as { scheduledAt: string }).scheduledAt)
  })

  it('renames and re-instructs a reminder without moving its committed target', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Original', every_seconds: 300, title: 'Original',
    })
    const updated = await execute(test, 'schedule_update', { id: record.id, title: ' Renamed ', prompt: 'New body' })
    expect(updated.value).toMatchObject({
      id: record.id, title: 'Renamed', prompt: 'New body', scheduledAt: record.scheduledAt, kind: 'every',
    })
    expect((await test.service.list({ sessionId: test.agent.session.id }))[0])
      .toMatchObject({ title: 'Renamed', prompt: 'New body', scheduledAt: record.scheduledAt })
  })

  it('returns the unchanged view for an update that changes nothing', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', every_seconds: 300, title: 'Keep',
    })
    expect((await execute(test, 'schedule_update', { id: record.id, title: 'Keep' })).value)
      .toMatchObject({ id: record.id, title: 'Keep', scheduledAt: record.scheduledAt })
  })

  it('reports an ended reminder as ended instead of unknown', async () => {
    const id = ScheduleId('ended-task')
    const test = await setup({ beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(id, {
        sessionId: SessionId('original'), status: 'inactive',
        record: createAfterScheduleRecord(id, 'Ended prompt', 1, Date.parse('2026-09-15T00:00:00.000Z'), 'Ended'),
      })
      await domain.close()
    } })
    expect((await execute(test, 'schedule_update', { id, title: 'Revive' })).value)
      .toEqual({ id, updated: false, code: 'schedule_ended' })
  })

  it('reports an unknown id without mutating the task table', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', every_seconds: 300, title: 'Keep',
    })
    expect((await execute(test, 'schedule_update', { id: 'missing', title: 'Nope' })).value)
      .toEqual({ id: 'missing', updated: false, code: 'schedule_not_found' })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([record])
  })

  it.each([
    ['an unknown argument', { id: 'task-1', bogus: true }, 'invalid_selector'],
    ['two selectors', { id: 'task-1', at: '2026-09-16T01:00:00Z', every_seconds: 600 }, 'invalid_selector'],
    ['no replacement at all', { id: 'task-1' }, 'invalid_selector'],
    ['an empty id', { id: '', title: 'Nope' }, 'invalid_rule'],
    ['an id with surrounding whitespace', { id: ' task-1 ', title: 'Nope' }, 'invalid_rule'],
    ['a blank title', { id: 'task-1', title: '   ' }, 'invalid_prompt'],
    ['an over-long title', { id: 'task-1', title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }, 'invalid_prompt'],
    ['a blank prompt', { id: 'task-1', prompt: '  ' }, 'invalid_prompt'],
    ['a fractional interval', { id: 'task-1', every_seconds: 300.5 }, 'invalid_rule'],
    ['an interval below the floor', { id: 'task-1', every_seconds: 59 }, 'frequency_too_high'],
  ])('rejects %s', async (_label, args, code) => {
    const test = await setup()
    expect((await execute(test, 'schedule_update', args)).value).toMatchObject({ code })
  })

  it('reports a missing required title with the shared message', async () => {
    const test = await setup()
    expect((await execute(test, 'schedule_update', { id: 'task-1', title: '' })).value)
      .toEqual({ code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE })
  })

  it('surfaces one invalid timing value from the domain rather than a generic failure', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', every_seconds: 300, title: 'Keep',
    })
    expect((await execute(test, 'schedule_update', {
      id: record.id, daily: { time: '09:00:00', time_zone: 'Mars/Olympus' },
    })).value).toMatchObject({ code: 'invalid_time_zone' })
  })

  it('rejects another Agent updating a reminder', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', every_seconds: 300, title: 'Keep',
    })
    const foreign = agentFor(test.ctx, 'other-update-caller')
    expect((await execute(test, 'schedule_update', { id: record.id, title: 'Foreign' }, foreign)).value)
      .toMatchObject({ code: 'internal_error' })
    expect((await test.service.list({ sessionId: test.agent.session.id }))[0])
      .toMatchObject({ title: 'Keep' })
  })

  it('refuses cancellation at the schedule_update body before reading the catalog', async () => {
    const test = await setup()
    const catalog = vi.spyOn(test.service, 'catalog')
    const value = await executeBody(test, 'schedule_update', { id: 'task-1', title: 'Canceled' }, AbortSignal.abort())
    expect(value).toMatchObject({ code: 'internal_error' })
    expect(catalog).not.toHaveBeenCalled()
  })

  it('withholds storage details from an update read failure', async () => {
    const test = await setup()
    vi.spyOn(test.service, 'list').mockRejectedValueOnce(new Error('private backend location'))
    expect((await execute(test, 'schedule_update', { id: 'task-1', title: 'Nope' })).value)
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
  })

  it('withholds storage details from an update write failure and keeps the stored fields', async () => {
    const test = await setup()
    const record = await test.service.create(test.agent.session.id, {
      prompt: 'Keep', every_seconds: 300, title: 'Keep',
    })
    test.pool.failNextWrites = 1
    expect((await execute(test, 'schedule_update', { id: record.id, title: 'Renamed' })).value)
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    expect(await test.service.list({ sessionId: test.agent.session.id })).toEqual([record])
  })

  it('removes earlier registrations if registering a later tool fails', async () => {
    const test = await setup()
    test.dispose()
    const register = test.ctx.tools.register.bind(test.ctx.tools)
    const failure = new Error('registration failed')
    vi.spyOn(test.ctx.tools, 'register')
      .mockImplementationOnce(definition => register(definition))
      .mockImplementationOnce(() => { throw failure })
    expect(() => registerScheduleTools(test.ctx, test.ctx, test.agent)).toThrow(failure)
    expect(test.ctx.tools.get('schedule_create')).toBeUndefined()
    expect(test.ctx.tools.get('schedule_list')).toBeUndefined()
    expect(test.ctx.tools.get('schedule_delete')).toBeUndefined()
  })

})
