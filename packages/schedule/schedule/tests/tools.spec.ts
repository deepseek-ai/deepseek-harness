import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { registerScheduleTools } from '../src/tools.ts'
import { runScheduleTransaction } from '../src/transaction.ts'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const signal = new AbortController().signal
const contexts: Context[] = []

interface ToolHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly flushes: { count: number; outcomes: Array<'resolve' | 'reject' | Promise<'resolve' | 'reject'>> }
  readonly changes: { count: number }
  readonly disposeTools: () => void
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
  return agent
}

async function harness(withPersistence = true): Promise<ToolHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `schedule-tools-${Math.random()}`)
  ctx.agents.register(agent)
  const flushes = { count: 0, outcomes: [] as Array<'resolve' | 'reject' | Promise<'resolve' | 'reject'>> }
  if (withPersistence) {
    ctx.on('session/flush', async () => {
      flushes.count += 1
      const outcome = await (flushes.outcomes.shift() ?? 'resolve')
      if (outcome === 'reject') return Promise.reject(new Error('disk unavailable'))
    })
  }
  const changes = { count: 0 }
  const disposeTools = registerScheduleTools(ctx, ctx, agent, () => { changes.count += 1 })
  return { ctx, agent, flushes, changes, disposeTools }
}

async function execute(
  test: ToolHarness,
  name: string,
  args: unknown,
  agent: Agent = test.agent,
  executionSignal: AbortSignal = signal,
): Promise<ToolExecutionResult> {
  return test.ctx.agents.withInitiator(agent, () => test.ctx.tools.execute({
    signal: executionSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  }))
}

function value(result: ToolExecutionResult): unknown {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected canonical Schedule value')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected deterministic text content')
  expect(JSON.parse(block.text)).toEqual(result.value)
  return result.value
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'))
})

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

describe('Schedule tool protocol', () => {
  it('registers three exclusive generic tools and disposes them together', async () => {
    const test = await harness()
    expect(['schedule_create', 'schedule_list', 'schedule_delete'].map(name => test.ctx.tools.get(name)?.name))
      .toEqual(['schedule_create', 'schedule_list', 'schedule_delete'])
    const outputSchema = test.ctx.tools.get('schedule_create')?.output.schema as {
      oneOf?: Array<{ properties?: { code?: { const?: string }; operation?: { enum?: string[] } } }>
    }
    const persistenceError = outputSchema.oneOf?.find(schema =>
      schema.properties?.code?.const === 'persistence_uncertain')
    expect(persistenceError?.properties?.operation?.enum).toEqual(['create', 'list', 'delete'])
    for (const name of ['schedule_create', 'schedule_list', 'schedule_delete']) {
      expect(test.ctx.tools.executionMode({ signal, callId: ToolCallId(name), name, arguments: {}, agent: test.agent }))
        .toEqual({ kind: 'exclusive' })
    }
    expect(test.ctx.tools.get('schedule_create')?.presentCall?.({ prompt: 'x', after_seconds: 1 }))
      .toEqual({ card: 'generic', title: 'Create reminder', kind: 'other', rawInput: 'x' })
    expect(test.ctx.tools.get('schedule_list')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'List reminders', kind: 'read' })
    expect(test.ctx.tools.get('schedule_delete')?.presentCall?.({ id: 'schedule-1' }))
      .toEqual({ card: 'generic', title: 'Delete reminder', kind: 'other', rawInput: 'schedule-1' })
    test.disposeTools()
    test.disposeTools()
    expect(test.ctx.tools.get('schedule_create')).toBeUndefined()
    expect(test.ctx.tools.get('schedule_list')).toBeUndefined()
    expect(test.ctx.tools.get('schedule_delete')).toBeUndefined()
  })

  it('rolls back earlier tool registrations when a later name conflicts', async () => {
    const test = await harness()
    const list = test.ctx.tools.get('schedule_list')
    if (list === undefined) throw new Error('expected registered list tool')
    test.disposeTools()
    const disposeConflict = test.ctx.tools.register(list)

    expect(() => registerScheduleTools(test.ctx, test.ctx, test.agent, () => {})).toThrow()
    expect(test.ctx.tools.get('schedule_create')).toBeUndefined()
    expect(test.ctx.tools.get('schedule_list')).toBe(list)
    expect(test.ctx.tools.get('schedule_delete')).toBeUndefined()
    disposeConflict()
  })

  it('rejects shape-known invalid create input before persistence', async () => {
    const test = await harness()
    expect(value(await execute(test, 'schedule_create', { prompt: ' ', after_seconds: 1 })))
      .toEqual({ code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' })
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', after_seconds: 0 })))
      .toEqual({ code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' })
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', after_seconds: 1.5 })))
      .toEqual({ code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' })
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', after_seconds: 1, at: 'later' })))
      .toEqual({
        code: 'invalid_selector',
        message: 'schedule_create accepts exactly one of after_seconds, at, or every_seconds.',
      })
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', every_seconds: 1.5 })))
      .toEqual({ code: 'invalid_rule', message: 'every_seconds must be a safe integer.' })
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', every_seconds: 299 })))
      .toEqual({ code: 'frequency_too_high', message: 'every_seconds must be at least 300.' })
    expect(test.flushes.count).toBe(0)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change')).toEqual([])
  })

  it('creates, lists, marks overdue, deletes, and never reuses an id', async () => {
    const test = await harness()
    expect(value(await execute(test, 'schedule_create', {
      prompt: '  check logs  ', after_seconds: 30,
    }))).toEqual({
      id: 'schedule-1',
      kind: 'after',
      prompt: 'check logs',
      afterSeconds: 30,
      scheduledAt: '2026-08-05T12:00:30.000Z',
      state: 'scheduled',
      deliveryMode: 'session-local',
    })
    expect(test.flushes.count).toBe(2)
    expect(test.changes.count).toBe(2)

    vi.setSystemTime(new Date('2026-08-05T12:00:31.000Z'))
    expect(value(await execute(test, 'schedule_list', {}))).toEqual([
      expect.objectContaining({ id: 'schedule-1', state: 'overdue' }),
    ])
    expect(test.flushes.count).toBe(3)
    expect(test.changes.count).toBe(3)

    expect(value(await execute(test, 'schedule_delete', { id: 'schedule-1' })))
      .toEqual({ id: 'schedule-1', deleted: true })
    expect(test.flushes.count).toBe(5)
    expect(test.changes.count).toBe(5)
    expect(value(await execute(test, 'schedule_delete', { id: 'schedule-1' })))
      .toEqual({ id: 'schedule-1', deleted: false, code: 'schedule_not_found' })
    expect(test.flushes.count).toBe(6)

    expect(value(await execute(test, 'schedule_create', { prompt: 'next', after_seconds: 1 })))
      .toMatchObject({ id: 'schedule-2' })
  })

  it('rejects an empty or padded delete id before persistence', async () => {
    const test = await harness()
    for (const id of ['', ' schedule-1']) {
      expect(value(await execute(test, 'schedule_delete', { id }))).toEqual({
        code: 'invalid_rule',
        message: 'schedule_delete id must be non-empty without surrounding whitespace.',
      })
    }
    expect(test.flushes.count).toBe(0)
  })

  it('creates offset and explicit-zone at records without persisting their input interpretation', async () => {
    const test = await harness()
    expect(value(await execute(test, 'schedule_create', {
      prompt: 'join meeting', at: '2026-08-06T09:00:00+08:00',
    }))).toEqual({
      id: 'schedule-1',
      kind: 'at',
      prompt: 'join meeting',
      scheduledAt: '2026-08-06T01:00:00.000Z',
      state: 'scheduled',
      deliveryMode: 'session-local',
    })
    expect(value(await execute(test, 'schedule_create', {
      prompt: 'local meeting',
      at: { date: '2026-08-07', time: '09:30:00', time_zone: 'Asia/Shanghai' },
    }))).toMatchObject({
      id: 'schedule-2',
      kind: 'at',
      scheduledAt: '2026-08-07T01:30:00.000Z',
    })
    expect(value(await execute(test, 'schedule_list', {}))).toEqual([
      expect.objectContaining({ id: 'schedule-1', kind: 'at' }),
      expect.objectContaining({ id: 'schedule-2', kind: 'at' }),
    ])
    const changes = test.agent.session.snapshotEvents()
      .filter(event => event.type === 'schedule/change' && event.data.operation === 'create')
    expect(changes.map((change) => {
      if (change.type !== 'schedule/change' || change.data.operation !== 'create') {
        throw new Error('expected only Schedule create changes')
      }
      return change.data.schedule
    })).toEqual([
      {
        id: 'schedule-1',
        kind: 'at',
        prompt: 'join meeting',
        scheduledAt: '2026-08-06T01:00:00.000Z',
      },
      {
        id: 'schedule-2',
        kind: 'at',
        prompt: 'local meeting',
        scheduledAt: '2026-08-07T01:30:00.000Z',
      },
    ])
  })

  it('creates and lists a fixed-rate record', async () => {
    const test = await harness()
    expect(value(await execute(test, 'schedule_create', {
      prompt: '  check metrics  ', every_seconds: 300,
    }))).toEqual({
      id: 'schedule-1',
      kind: 'every',
      prompt: 'check metrics',
      everySeconds: 300,
      scheduledAt: '2026-08-05T12:05:00.000Z',
      state: 'scheduled',
      deliveryMode: 'session-local',
    })
    vi.setSystemTime(new Date('2026-08-05T12:06:00.000Z'))
    expect(value(await execute(test, 'schedule_list', {}))).toEqual([
      expect.objectContaining({
        id: 'schedule-1',
        kind: 'every',
        everySeconds: 300,
        state: 'overdue',
      }),
    ])
  })

  it('returns stable at validation errors after persistence preflight', async () => {
    const test = await harness()
    expect(value(await execute(test, 'schedule_create', {
      prompt: 'bad instant', at: '2026-08-06T09:00:00',
    }))).toEqual({
      code: 'invalid_rule',
      message: 'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.',
    })
    expect(value(await execute(test, 'schedule_create', {
      prompt: 'bad zone', at: { date: '2026-08-06', time: '09:00:00', time_zone: 'CST' },
    }))).toEqual({
      code: 'invalid_time_zone',
      message: 'time_zone must be UTC or a valid IANA Area/Location name.',
    })
    expect(value(await execute(test, 'schedule_create', {
      prompt: 'past', at: '2026-08-05T12:00:00Z',
    }))).toEqual({
      code: 'not_future',
      message: 'The scheduled time must be strictly in the future.',
    })
    expect(test.flushes.count).toBe(3)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change')).toEqual([])
  })

  it('returns a range error only after the create preflight', async () => {
    const test = await harness()
    expect(value(await execute(test, 'schedule_create', {
      prompt: 'far future', after_seconds: Number.MAX_SAFE_INTEGER,
    }))).toEqual({
      code: 'time_out_of_range',
      message: 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
    })
    expect(test.flushes.count).toBe(1)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change')).toEqual([])

    const internal = await harness()
    const now = vi.spyOn(Date, 'now').mockImplementationOnce(() => { throw new Error('clock unavailable') })
    expect(value(await execute(internal, 'schedule_create', { prompt: 'clock', after_seconds: 1 })))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    now.mockRestore()
  })

  it('contains a projection observer failure after the create barrier', async () => {
    const test = await harness()
    test.disposeTools()
    let calls = 0
    const dispose = registerScheduleTools(test.ctx, test.ctx, test.agent, () => {
      calls += 1
      if (calls === 1) throw new Error('observer failed')
      throw 'observer failed again'
    })
    expect(value(await execute(test, 'schedule_create', { prompt: 'still committed', after_seconds: 1 })))
      .toMatchObject({ id: 'schedule-1', state: 'scheduled' })
    expect(value(await execute(test, 'schedule_delete', { id: 'schedule-1' })))
      .toEqual({ id: 'schedule-1', deleted: true })
    dispose()
  })

  it('treats missing persistence as uncertainty rather than a successful no-op', async () => {
    const test = await harness(false)
    expect(value(await execute(test, 'schedule_list', {}))).toEqual({
      code: 'persistence_uncertain',
      message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
      operation: 'list',
    })
  })
})

describe('Schedule persistence failure boundaries', () => {
  it('does not fold an unconfirmed corrupt live suffix before preflight succeeds', async () => {
    const test = await harness()
    Object.defineProperty(test.agent.session, 'snapshotEvents', {
      configurable: true,
      value: () => [{
        type: 'schedule/change',
        seq: 0,
        time: Date.now(),
        data: { version: 2, operation: 'create', schedule: {} },
      }],
    })
    test.flushes.outcomes.push('reject', 'resolve')
    expect(value(await execute(test, 'schedule_list', {}))).toMatchObject({
      code: 'persistence_uncertain', operation: 'list',
    })
    expect(value(await execute(test, 'schedule_list', {}))).toEqual({
      code: 'corrupt_schedule_log', message: 'The session schedule log is corrupt.',
    })
  })

  it('reports a create barrier rejection with the known appended id and recovers on list preflight', async () => {
    const test = await harness()
    test.flushes.outcomes.push('resolve', 'reject', 'resolve')
    expect(value(await execute(test, 'schedule_create', { prompt: 'persist me', after_seconds: 10 })))
      .toEqual({
        code: 'persistence_uncertain',
        message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
        operation: 'create',
        id: 'schedule-1',
      })
    expect(test.changes.count).toBe(1)
    expect(value(await execute(test, 'schedule_list', {}))).toEqual([
      expect.objectContaining({ id: 'schedule-1' }),
    ])
    expect(test.changes.count).toBe(2)
  })

  it('serializes concurrent management transactions across both persistence barriers', async () => {
    const test = await harness()
    let releaseCreatePreflight: (() => void) | undefined
    const createPreflight = new Promise<'resolve'>((resolve) => {
      releaseCreatePreflight = () => { resolve('resolve') }
    })
    test.flushes.outcomes.push(createPreflight, 'reject', 'resolve')

    const creating = execute(test, 'schedule_create', { prompt: 'persist me', after_seconds: 10 })
    await vi.waitFor(() => { expect(test.flushes.count).toBe(1) })
    const listing = execute(test, 'schedule_list', {})
    await Promise.resolve()
    expect(test.flushes.count).toBe(1)

    if (releaseCreatePreflight === undefined) throw new Error('missing create preflight release')
    releaseCreatePreflight()
    expect(value(await creating)).toMatchObject({
      code: 'persistence_uncertain', operation: 'create', id: 'schedule-1',
    })
    expect(value(await listing)).toEqual([
      expect.objectContaining({ id: 'schedule-1', prompt: 'persist me' }),
    ])
    expect(test.flushes.count).toBe(3)
  })

  it('does not persist a create cancelled while it waits in the Schedule FIFO', async () => {
    const test = await harness()
    let releaseOwner: (() => void) | undefined
    let markOwnerStarted: (() => void) | undefined
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve
    })
    const owner = runScheduleTransaction(test.agent, async () => {
      markOwnerStarted?.()
      await new Promise<void>((resolve) => { releaseOwner = resolve })
    })
    await ownerStarted

    const controller = new AbortController()
    const creating = execute(test, 'schedule_create', {
      prompt: 'cancelled before its turn', after_seconds: 1,
    }, test.agent, controller.signal)
    await Promise.resolve()
    controller.abort()
    if (releaseOwner === undefined) throw new Error('missing owner transaction release')
    releaseOwner()
    await owner

    await expect(creating).resolves.toMatchObject({
      isError: true,
      error: { info: { name: 'AbortError', code: 'ABORTED' } },
    })
    expect(test.flushes.count).toBe(0)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change')).toEqual([])
  })

  it('does not persist a create cancelled during its first preflight', async () => {
    const test = await harness()
    let releaseCreate: (() => void) | undefined
    const blockedCreate = new Promise<'resolve'>((resolve) => {
      releaseCreate = () => { resolve('resolve') }
    })
    test.flushes.outcomes.push(blockedCreate)
    const controller = new AbortController()
    const creating = execute(test, 'schedule_create', {
      prompt: 'cancelled during preflight', after_seconds: 1,
    }, test.agent, controller.signal)
    await vi.waitFor(() => { expect(test.flushes.count).toBe(1) })
    controller.abort()
    if (releaseCreate === undefined) throw new Error('missing create preflight release')
    releaseCreate()

    await expect(creating).resolves.toMatchObject({
      isError: true,
      error: { info: { name: 'AbortError', code: 'ABORTED' } },
    })
    expect(test.flushes.count).toBe(1)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change')).toEqual([])
  })

  it('does not persist a delete cancelled during its first preflight', async () => {
    const test = await harness()
    await execute(test, 'schedule_create', { prompt: 'keep me', after_seconds: 60 })
    let releaseDelete: (() => void) | undefined
    const blockedDelete = new Promise<'resolve'>((resolve) => {
      releaseDelete = () => { resolve('resolve') }
    })
    test.flushes.outcomes.push(blockedDelete)
    const controller = new AbortController()
    const deleting = execute(test, 'schedule_delete', { id: 'schedule-1' }, test.agent, controller.signal)
    await vi.waitFor(() => { expect(test.flushes.count).toBe(3) })
    controller.abort()
    if (releaseDelete === undefined) throw new Error('missing delete preflight release')
    releaseDelete()

    await expect(deleting).resolves.toMatchObject({
      isError: true,
      error: { info: { name: 'AbortError', code: 'ABORTED' } },
    })
    expect(test.flushes.count).toBe(3)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change'))
      .toHaveLength(1)
    expect(value(await execute(test, 'schedule_list', {})))
      .toEqual([expect.objectContaining({ id: 'schedule-1' })])
  })

  it('returns uncertainty before create or delete reads when their preflight rejects', async () => {
    const createTest = await harness()
    createTest.flushes.outcomes.push('reject')
    expect(value(await execute(createTest, 'schedule_create', { prompt: 'later', after_seconds: 1 })))
      .toMatchObject({ code: 'persistence_uncertain', operation: 'create' })
    expect(createTest.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change')).toEqual([])

    const deleteTest = await harness()
    await execute(deleteTest, 'schedule_create', { prompt: 'keep', after_seconds: 1 })
    deleteTest.flushes.outcomes.push('reject')
    expect(value(await execute(deleteTest, 'schedule_delete', { id: 'schedule-1' })))
      .toMatchObject({ code: 'persistence_uncertain', operation: 'delete', id: 'schedule-1' })
    expect(deleteTest.agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ operation: 'create' })
  })

  it('maps corrupt and unreadable folds for create, list, and delete', async () => {
    const corrupt = await harness()
    Object.defineProperty(corrupt.agent.session, 'snapshotEvents', {
      configurable: true,
      value: () => [{
        type: 'schedule/change', seq: 0, time: Date.now(),
        data: { version: 9, operation: 'delete', id: 'schedule-1' },
      }],
    })
    expect(value(await execute(corrupt, 'schedule_create', { prompt: 'x', after_seconds: 1 })))
      .toMatchObject({ code: 'corrupt_schedule_log' })
    expect(value(await execute(corrupt, 'schedule_delete', { id: 'schedule-1' })))
      .toMatchObject({ code: 'corrupt_schedule_log' })

    const unreadable = await harness()
    Object.defineProperty(unreadable.agent.session, 'snapshotEvents', {
      configurable: true,
      value: () => { throw 'unreadable log' },
    })
    expect(value(await execute(unreadable, 'schedule_list', {})))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
  })

  it('reports a delete barrier rejection and lets the next preflight clarify the terminal record', async () => {
    const test = await harness()
    await execute(test, 'schedule_create', { prompt: 'delete me', after_seconds: 10 })
    test.flushes.outcomes.push('resolve', 'reject', 'resolve')
    expect(value(await execute(test, 'schedule_delete', { id: 'schedule-1' }))).toMatchObject({
      code: 'persistence_uncertain', operation: 'delete', id: 'schedule-1',
    })
    expect(value(await execute(test, 'schedule_list', {}))).toEqual([])
  })

  it('contains append failures and refuses cross-owner execution', async () => {
    const test = await harness()
    const stop = test.ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName === 'session/event' && (args as unknown[])[1] !== undefined) throw new Error('append denied')
    }, { global: true, prepend: true })
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', after_seconds: 1 })))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    stop()

    const other = stubAgent(test.ctx, `other-${Math.random()}`)
    test.ctx.agents.register(other)
    expect(value(await execute(test, 'schedule_create', { prompt: 'x', after_seconds: 1 }, other)))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    expect(value(await execute(test, 'schedule_list', {}, other)))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    expect(value(await execute(test, 'schedule_delete', { id: 'schedule-1' }, other)))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
  })

  it('contains a delete append failure after a successful preflight', async () => {
    const test = await harness()
    await execute(test, 'schedule_create', { prompt: 'x', after_seconds: 1 })
    const stop = test.ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const event = (args as unknown[])[1] as { type?: string; data?: { operation?: string } } | undefined
      if (event?.type === 'schedule/change' && event.data?.operation === 'delete') throw new Error('append denied')
    }, { global: true, prepend: true })
    expect(value(await execute(test, 'schedule_delete', { id: 'schedule-1' })))
      .toEqual({ code: 'internal_error', message: 'The schedule operation failed.' })
    stop()
  })
})
