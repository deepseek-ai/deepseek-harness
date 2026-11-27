import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  mountAgentLoopTestDependencies,
  unsupportedInbox,
  unsupportedModel,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  MockAdapter,
  textResponse,
  toolCallResponse,
} from '../../../core/agent-loop/tests/mock-adapter.ts'

const REMINDER_PREFIX = [
  '<system-reminder>',
  'An open task list has remained unchanged while the work continued. Reconcile it with actual '
    + 'progress before proceeding when the list is still useful. Invoke `todo_write` with `todos` set '
    + 'to the entire replacement array: move finished work to `completed` as soon as it finishes, '
    + 'mark work currently underway `in_progress`, and leave later work `pending`. Rebuild the array '
    + 'when its items no longer match the task. If tracking adds no value, clear the recorded list '
    + 'with `todos: []`. Keep this maintenance note out of the response to the user.',
  '',
  'Current todo list:',
].join('\n')
const REMINDER_SUFFIX = '</system-reminder>'
const TRUNCATION_NOTICE =
  '[todo items outside this excerpt omitted; rebuild or clear the list instead of guessing their contents]'
const reminderText = (...lines: string[]): string =>
  [REMINDER_PREFIX, ...lines, REMINDER_SUFFIX].join('\n')
const REMINDER_TEXT = reminderText(
  '1. [completed] "Inspect \\"state\\""',
  '2. [in_progress] "Apply fix"',
)
const TRUNCATED_REMINDER_TEXT = reminderText(TRUNCATION_NOTICE)

async function loopHarness(reminder?: ToolTodo.ReminderConfig): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true, ...reminder ? { reminder } : {} })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'Continue the test task.',
    parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
  }))
  return ctx
}

async function directHarness(reminder?: ToolTodo.ReminderConfig): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolRegistry)
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true, ...reminder ? { reminder } : {} })
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: changed, status }) => {
      if (changed === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function reminders(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message'
    && event.data.source.kind === 'todo-reminder')
}

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function sessionAgent(
  session: Session,
  id = 'todo-reminder-agent',
  agentCtx = new Context(),
): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('todo reminder must enter the current pre-step decision') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function appendAssistant(session: Session, step: number): void {
  session.append('assistant/message', {
    turn: 1,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `assistant ${String(step)}` }],
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

async function propose(
  ctx: Context,
  agent: Agent,
  signal = new AbortController().signal,
  terminal: PreStepDecision = { kind: 'enter', messages: [] },
): Promise<PreStepDecision> {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'mock' }, messages: [], turn: 1, step: 20, signal },
    () => Promise.resolve(terminal),
  )
}

describe('Todo update reminder scheduling', () => {
  it('defaults reminder to disabled and rejects invalid reminder policy at the configuration boundary', () => {
    expect(ToolTodo.Config({ allowParallelInProgress: true })).toEqual({
      allowParallelInProgress: true,
      reminder: {
        enabled: false,
        intervalSteps: 64,
        maxReminderChars: 16 * 1024,
      },
    })
    for (const intervalSteps of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => ToolTodo.Config({
        allowParallelInProgress: true,
        reminder: { enabled: true, intervalSteps },
      })).toThrow()
    }
    const minimum = TRUNCATED_REMINDER_TEXT.length
    expect(ToolTodo.Config({
      allowParallelInProgress: true,
      reminder: { enabled: true, maxReminderChars: minimum },
    }).reminder?.maxReminderChars).toBe(minimum)
    expect(() => ToolTodo.Config({
      allowParallelInProgress: true,
      reminder: { enabled: true, maxReminderChars: minimum - 1 },
    })).toThrow()
  })

  it('stays disabled by default without injecting reminders or registering todoReminder checkpoints', async () => {
    const ctx = await directHarness()
    const session = Session.create(SessionId('disabled-default'))
    session.append('todo/write', { todos: [{ content: 'Still open', status: 'in_progress' }] })
    for (let step = 1; step <= 12; step += 1) appendAssistant(session, step)

    expect(await propose(ctx, sessionAgent(session))).toEqual({ kind: 'enter', messages: [] })
    expect(ctx.sessionProjections.checkpoint(session)).not.toHaveProperty('todoReminder')
  })

  it('injects the current list after the configured number of assistant messages', async () => {
    const ctx = await loopHarness({ enabled: true, intervalSteps: 2 })
    const adapter = new MockAdapter([
      toolCallResponse('todo', 'todo_write', { todos: [
        { content: 'Inspect "state"', status: 'completed' },
        { content: 'Apply fix', status: 'in_progress' },
      ] }),
      toolCallResponse('probe-1', 'probe', {}),
      toolCallResponse('probe-2', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('threshold'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Do the multi-step task.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const [event] = reminders(agent)
    expect(event?.data.content).toEqual([{ type: 'text', text: REMINDER_TEXT }])
    expect(event?.data.source).toEqual({
      kind: 'todo-reminder',
      form: 'snapshot',
      sections: [{ name: 'todo-reminder', text: REMINDER_TEXT }],
    })
    expect(adapter.requests.slice(0, 3).every(request =>
      !requestText(request).includes('An open task list has remained unchanged'))).toBe(true)
    expect(requestText(adapter.requests[3] as GenerateOptions)).toContain(REMINDER_TEXT)
  })

  it('uses each injected reminder as the next cadence anchor', async () => {
    const ctx = await loopHarness({ enabled: true, intervalSteps: 1 })
    const adapter = new MockAdapter([
      toolCallResponse('todo', 'todo_write', { todos: [
        { content: 'Continue work', status: 'in_progress' },
      ] }),
      toolCallResponse('probe-1', 'probe', {}),
      toolCallResponse('probe-2', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('cadence'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue until done.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(2)
    expect(adapter.requests.slice(0, 2).every(request =>
      !requestText(request).includes('An open task list has remained unchanged'))).toBe(true)
    expect(adapter.requests.slice(2).every(request =>
      requestText(request).includes('An open task list has remained unchanged'))).toBe(true)
  })

  it('resets on a Todo write and stops once the replacement list is complete', async () => {
    const ctx = await loopHarness({ enabled: true, intervalSteps: 2 })
    const adapter = new MockAdapter([
      toolCallResponse('todo-open', 'todo_write', { todos: [
        { content: 'Apply fix', status: 'in_progress' },
      ] }),
      toolCallResponse('probe-1', 'probe', {}),
      toolCallResponse('todo-done', 'todo_write', { todos: [
        { content: 'Apply fix', status: 'completed' },
      ] }),
      toolCallResponse('probe-2', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('write-reset'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Update the task list as work changes.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toEqual([])
  })

  it('reconstructs the default 64-message cadence from the durable log', async () => {
    const ctx = await directHarness({ enabled: true })
    const session = Session.create(SessionId('resume'))
    appendAssistant(session, 0)
    session.append('todo/write', { todos: [{ content: 'Resume work', status: 'pending' }] })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'already anchored' }],
      source: { kind: 'todo-reminder', form: 'snapshot', sections: [{ name: 'todo-reminder', text: 'already anchored' }] },
    }), { surfaceOp: 'append' })
    for (let step = 1; step < 64; step += 1) appendAssistant(session, step)
    const agent = sessionAgent(session)
    expect(await propose(ctx, agent)).toMatchObject({ kind: 'enter', messages: [] })
    appendAssistant(session, 64)

    const decision = await propose(ctx, agent)

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0]?.source).toMatchObject({
      kind: 'todo-reminder',
    })
  })

  it('restores projection checkpoints and suffix without reading prefix history', async () => {
    const ctx = await directHarness({ enabled: true, intervalSteps: 2 })
    const original = Session.create(SessionId('checkpoint-source'))
    original.append('todo/write', { todos: [{ content: 'Checkpoint work', status: 'in_progress' }] })
    appendAssistant(original, 1)
    const cut = original.seq
    const rawCheckpoint = ctx.sessionProjections.checkpoint(original)
    const checkpoint = JSON.parse(JSON.stringify(rawCheckpoint)) as typeof rawCheckpoint
    appendAssistant(original, 2)
    const suffix = original.snapshotEvents(cut)
    const restored = ctx.sessionProjections.restore(
      checkpoint,
      suffix,
      cut,
      original.header,
      original.inheritedEventCount,
    )
    expect(restored.checkpoint['todoReminder']).toEqual(ctx.sessionProjections.checkpoint(original)['todoReminder'])

    const cold = Session.create(SessionId('checkpoint-cold'), original.snapshotEvents())
    ctx.sessionProjections.hydrate(cold, checkpoint, suffix, cut)
    const decision = await propose(ctx, sessionAgent(cold))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages).toHaveLength(1)
  })

  it('centers a bounded excerpt on the completed-to-unfinished transition', async () => {
    const boundary = [
      '3. [completed] "just finished"',
      '4. [in_progress] "working now"',
      '5. [pending] "next"',
    ]
    const expected = reminderText(...boundary, TRUNCATION_NOTICE)
    const maxReminderChars = expected.length
    const ctx = await directHarness({
      enabled: true,
      intervalSteps: 1,
      maxReminderChars,
    })
    const session = Session.create(SessionId('exact-limit'))
    session.append('todo/write', { todos: [
      { content: 'old completed item '.repeat(20), status: 'completed' },
      { content: 'earlier completed item', status: 'completed' },
      { content: 'just finished', status: 'completed' },
      { content: 'working now', status: 'in_progress' },
      { content: 'next', status: 'pending' },
      { content: '界'.repeat(100), status: 'pending' },
    ] })
    appendAssistant(session, 1)

    const decision = await propose(ctx, sessionAgent(session))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: expected }])
    expect(expected).toHaveLength(maxReminderChars)
    expect(expected).not.toContain('earlier completed item')
  })

  it('keeps unfinished work when the preceding completed item does not fit', async () => {
    const excerpt = [
      '2. [in_progress] "working now"',
      '3. [pending] "next"',
    ]
    const expected = reminderText(...excerpt, TRUNCATION_NOTICE)
    const ctx = await directHarness({
      enabled: true,
      intervalSteps: 1,
      maxReminderChars: expected.length,
    })
    const session = Session.create(SessionId('oversized-predecessor'))
    session.append('todo/write', { todos: [
      { content: 'completed '.repeat(100), status: 'completed' },
      { content: 'working now', status: 'in_progress' },
      { content: 'next', status: 'pending' },
    ] })
    appendAssistant(session, 1)

    const decision = await propose(ctx, sessionAgent(session))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: expected }])
  })

  it('keeps a first unfinished item without a completed boundary', async () => {
    const expected = reminderText('1. [in_progress] "working now"', TRUNCATION_NOTICE)
    const ctx = await directHarness({
      enabled: true,
      intervalSteps: 1,
      maxReminderChars: expected.length,
    })
    const session = Session.create(SessionId('no-completed-boundary'))
    session.append('todo/write', { todos: [
      { content: 'working now', status: 'in_progress' },
      { content: '界'.repeat(100), status: 'pending' },
    ] })
    appendAssistant(session, 1)

    const decision = await propose(ctx, sessionAgent(session))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: expected }])
  })

  it('uses spare characters for earlier completed work after later work stops the excerpt', async () => {
    const excerpt = [
      '1. [completed] "earlier"',
      '2. [completed] "just finished"',
      '3. [in_progress] "working now"',
    ]
    const expected = reminderText(...excerpt, TRUNCATION_NOTICE)
    const ctx = await directHarness({
      enabled: true,
      intervalSteps: 1,
      maxReminderChars: expected.length,
    })
    const session = Session.create(SessionId('completed-backfill'))
    session.append('todo/write', { todos: [
      { content: 'earlier', status: 'completed' },
      { content: 'just finished', status: 'completed' },
      { content: 'working now', status: 'in_progress' },
      { content: '界'.repeat(100), status: 'pending' },
    ] })
    appendAssistant(session, 1)

    const decision = await propose(ctx, sessionAgent(session))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: expected }])
  })

  it('omits an oversized item when only the minimum reminder fits', async () => {
    const maxReminderChars = TRUNCATED_REMINDER_TEXT.length
    const ctx = await directHarness({ enabled: true, intervalSteps: 1, maxReminderChars })
    const session = Session.create(SessionId('minimum-limit'))
    session.append('todo/write', { todos: [
      { content: '界'.repeat(100), status: 'in_progress' },
    ] })
    appendAssistant(session, 1)

    const decision = await propose(ctx, sessionAgent(session))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected an entered step')
    expect(decision.messages[0]?.content).toEqual([
      { type: 'text', text: TRUNCATED_REMINDER_TEXT },
    ])
    expect(TRUNCATED_REMINDER_TEXT).toHaveLength(maxReminderChars)
  })

  it('stays inert when todo_write is restricted, the step is rejected, or the signal aborted', async () => {
    let dueCounter = 0
    const due = (): Session => {
      const session = Session.create(SessionId(`due-${String(++dueCounter)}`))
      session.append('todo/write', { todos: [{ content: 'Pending', status: 'pending' }] })
      appendAssistant(session, 1)
      return session
    }

    const loopCtx = await loopHarness({ enabled: true, intervalSteps: 1 })
    const restrictedAgent = await loopCtx.agentLoop.create(SessionId('restricted-tool'), { provider: 'mock', model: 'mock' })
    restrictedAgent.session.append('todo/write', { todos: [{ content: 'Pending', status: 'pending' }] })
    appendAssistant(restrictedAgent.session, 1)
    restrictedAgent.ctx.tools.restrict({ deny: ['todo_write'] })
    expect(await propose(loopCtx, restrictedAgent)).toEqual({ kind: 'enter', messages: [] })

    const ctx = await directHarness({ enabled: true, intervalSteps: 1 })
    expect(await propose(ctx, sessionAgent(due(), 'rejected'), undefined, { kind: 'reject' }))
      .toEqual({ kind: 'reject' })

    const controller = new AbortController()
    controller.abort()
    expect(await propose(ctx, sessionAgent(due(), 'aborted'), controller.signal))
      .toEqual({ kind: 'enter', messages: [] })
  })

  it('removes its reminder listeners on disposal', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(ToolTodo, {
      allowParallelInProgress: true,
      reminder: { enabled: true, intervalSteps: 1 },
    })
    await fiber.dispose()
    const session = Session.create(SessionId('disposed'))
    session.append('todo/write', { todos: [{ content: 'Pending', status: 'pending' }] })
    appendAssistant(session, 1)

    expect(await propose(ctx, sessionAgent(session))).toEqual({ kind: 'enter', messages: [] })
  })
})
