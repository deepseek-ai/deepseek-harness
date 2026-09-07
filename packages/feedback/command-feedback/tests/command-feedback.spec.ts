import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { foldSurface, Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandFeedback from '@deepseek-ai/dsh-command-feedback'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const { USER_ID, getOrCreateAnonymousUserId } = vi.hoisted(() => {
  const USER_ID = '01234567-89ab-4cde-8f01-23456789abcd'
  return { USER_ID, getOrCreateAnonymousUserId: vi.fn(() => USER_ID) }
})

vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({
  getOrCreateAnonymousUserId,
}))

beforeEach(() => getOrCreateAnonymousUserId.mockClear())

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  const plugin = await ctx.plugin(commandFeedback)
  const { agent, session } = stubAgent(ctx, `command-feedback-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** Execute `/feedback` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<{ kind: string; text?: string }> {
  const settled = await test.ctx.commands.execute(
    test.agent,
    `/feedback${suffix}`,
    [],
    new AbortController().signal,
  )
  if (settled === undefined) throw new Error('feedback command was not registered')
  return settled.result
}

/** Authoritative feedback payloads in log order. */
function feedbackTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'feedback/record')
    .map(event => event.data.text)
}

describe('@deepseek-ai/dsh-command-feedback registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandFeedback.name).toBe('command-feedback')
    expect(commandFeedback.inject).toEqual(['commands'])
    expect('default' in commandFeedback).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandFeedback)).toBe(commandFeedback)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'feedback',
      description: 'record feedback about this session',
      input: { hint: '<text>' },
    })
    expect(test.ctx.commands.find(test.agent, 'feedback')).toMatchObject({ recordInput: false })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'feedback')).toBeUndefined()
  })
})

describe('/feedback human command', () => {
  it('acknowledges feedback and records its payload exactly once in the domain event', async () => {
    const test = await harness()
    await expect(run(test, ' the diff view is unreadable')).resolves.toEqual({
      kind: 'success',
      text: `Feedback recorded for session ${test.session.id}\nAnonymous user: ${USER_ID}.`,
    })
    expect(feedbackTexts(test.session)).toEqual(['the diff view is unreadable'])
    const commandRun = test.session.snapshotEvents().find(event => event.type === 'command/run')
    expect(commandRun?.type === 'command/run' && Object.hasOwn(commandRun.data, 'args')).toBe(false)
    expect(JSON.stringify(test.session.snapshotEvents()).match(/the diff view is unreadable/gu)).toHaveLength(1)
  })

  it('exports a command-independent feedback producer', async () => {
    const test = await harness()
    commandFeedback.recordFeedback(test.session, '  recorded outside a command  ')
    expect(test.session.snapshotEvents().map(event => event.type)).toEqual(['feedback/record'])
    expect(feedbackTexts(test.session)).toEqual(['recorded outside a command'])
    expect(() => { commandFeedback.recordFeedback(test.session, ' \n\t ') })
      .toThrow('feedback text must not be empty')
    expect(feedbackTexts(test.session)).toEqual(['recorded outside a command'])
  })

  it('keeps command bookkeeping around the authoritative feedback event', async () => {
    const test = await harness()
    await run(test, ' nothing else happens')
    expect(test.session.snapshotEvents().map(event => event.type)).toEqual([
      'command/run', 'feedback/record', 'command/done',
    ])
  })

  it('normalizes surrounding whitespace without parsing command-like content', async () => {
    const test = await harness()
    await run(test, ' /plan felt SLOW\n\ttwice today ')
    expect(feedbackTexts(test.session)).toEqual(['/plan felt SLOW\n\ttwice today'])
  })

  it('records each entry separately without replacing earlier ones', async () => {
    const test = await harness()
    await run(test, ' first')
    await run(test, ' second')
    expect(feedbackTexts(test.session)).toEqual(['first', 'second'])
  })

  it('records concurrent submissions in dispatch order', async () => {
    const test = await harness()
    const signal = new AbortController().signal
    // Command adapters may dispatch concurrent requests without awaiting one another.
    const settled = await Promise.all([
      test.ctx.commands.execute(test.agent, '/feedback first', [], signal),
      test.ctx.commands.execute(test.agent, '/feedback second', [], signal),
    ])
    expect(settled.map(item => item?.result)).toEqual([
      { kind: 'success', text: `Feedback recorded for session ${test.session.id}\nAnonymous user: ${USER_ID}.` },
      { kind: 'success', text: `Feedback recorded for session ${test.session.id}\nAnonymous user: ${USER_ID}.` },
    ])
    expect(feedbackTexts(test.session)).toEqual(['first', 'second'])
  })

  it('keeps every recorded event out of model context and derived history', async () => {
    const test = await harness()
    await run(test, ' invisible to the model')
    for (const event of test.session.snapshotEvents()) {
      expect('surfaceOp' in event).toBe(false)
      expect(test.session.deriveEventMessage(event)).toBeNull()
    }
    expect(foldSurface(test.session.snapshotEvents()).nodes).toEqual([])
    expect(test.session.surface.nodes).toEqual([])
    expect(test.session.deriveMessages()).toEqual([])
  })

  it('rejects empty and whitespace-only input as a failed command record', async () => {
    const test = await harness()
    const expected = {
      kind: 'error',
      text: 'Feedback text is required. Usage: /feedback <text>',
    }
    await expect(run(test)).resolves.toEqual(expected)
    await expect(run(test, '   \n\t ')).resolves.toEqual(expected)
    expect(getOrCreateAnonymousUserId).not.toHaveBeenCalled()
    expect(feedbackTexts(test.session)).toEqual([])
    const done = test.session.snapshotEvents().filter(event => event.type === 'command/done')
    expect(done.map(event => event.data.kind)).toEqual(['error', 'error'])
    for (const event of test.session.snapshotEvents()) {
      if (event.type === 'command/run') expect(Object.hasOwn(event.data, 'args')).toBe(false)
    }
  })

  it('records nothing when dispatch rejects an already-cancelled request', async () => {
    const test = await harness()
    const controller = new AbortController()
    controller.abort(new Error('user cancelled the command'))
    await expect(test.ctx.commands.execute(test.agent, '/feedback too late', [], controller.signal))
      .rejects.toThrow('user cancelled the command')
    expect(test.session.snapshotEvents()).toEqual([])
  })
})
