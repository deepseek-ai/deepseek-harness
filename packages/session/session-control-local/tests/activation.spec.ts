import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionControl from '@deepseek-ai/dsh-session-control'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SessionControlLocalProvider from '../src/index.ts'

class PointQuery extends SessionQuery {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('search is not used by activation'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('search is not used by activation'))
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  let selection: ModelSelection = { provider: 'fixture', model: 'first' }
  ctx.provide('agentDefaultModel', {
    currentSelection: () => selection,
  } satisfies Pick<Context['agentDefaultModel'], 'currentSelection'>)
  await ctx.plugin(SessionControl)
  await ctx.plugin(PointQuery)
  await ctx.plugin(SessionControlLocalProvider)
  return {
    ctx,
    activation: ctx.sessionControlLocal,
    select: (value: ModelSelection) => { selection = value },
  }
}

function observation(meta: Partial<SessionHeader> = {}, preset?: string): SessionObservation {
  return {
    source: 'prepared',
    header: {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('target'),
      createdAt: 1,
      isSeeded: false,
      ...meta,
    },
    inheritedEventCount: SessionLogOffset(0),
    events: [],
    cursor: -1,
    projections: { asOfSeq: -1, values: preset === undefined ? {} : { agentPreset: preset } },
    retain() { return this },
    [Symbol.dispose]() {},
  }
}

function handle(ctx: Context, header: SessionHeader) {
  const session = ctx.sessions.create(header.id, { meta: header })
  return {
    agent: { id: header.id, session, status: 'idle', ctx } as Agent,
    dispose: vi.fn(async () => {}),
  } satisfies AgentHandle
}

describe('ordinary Session activation', () => {
  it('binds a resumed handle to the calling plugin lifetime', async () => {
    const { ctx } = await harness()
    const observed = observation()
    const expected = handle(ctx, observed.header)
    ctx.agents.setFactory({
      async createAgent() { throw new Error('unexpected create') },
      async resume(ownerCtx) {
        ownerCtx.effect(() => () => expected.dispose())
        return expected
      },
    })
    const caller = await ctx.plugin({
      inject: ['sessionControlLocal'],
      async apply(callerCtx: Context) {
        await expect(callerCtx.sessionControlLocal.resumeObserved(observed)).resolves.toBe(expected)
      },
    })

    expect(expected.dispose).not.toHaveBeenCalled()
    await caller.dispose()
    expect(expected.dispose).toHaveBeenCalledOnce()
    expect(ctx.sessionControlLocal).toBeDefined()
  })

  it('restores a cwd-less ordinary Session and returns its owned handle', async () => {
    const { ctx, activation } = await harness()
    const observed = observation()
    const expected = handle(ctx, observed.header)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue(expected)
    const signal = new AbortController().signal

    await expect(activation.resumeObserved(observed, signal)).resolves.toBe(expected)
    expect(resume).toHaveBeenCalledOnce()
    const options = resume.mock.calls[0]![0]
    expect(options).toMatchObject({
      resumeSessionId: observed.header.id,
      signal,
      agentOptions: { provider: 'fixture', model: 'first', reasoningEffort: undefined },
    })
    expect(options.setup).toBeTypeOf('function')
    await options.setup?.(ctx, expected.agent)
    expect(expected.dispose).not.toHaveBeenCalled()
  })

  it('restores the projected preset and mounts it before publication', async () => {
    const { ctx, activation } = await harness()
    const observed = observation({ agentPreset: 'initial' }, 'selected')
    const expected = handle(ctx, observed.header)
    const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default' }))
    const mount = vi.fn(async () => ({ id: 'selected' }))
    ctx.provide('agentPresets', { resolve, mount } satisfies Pick<Context['agentPresets'], 'resolve' | 'mount'>)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue(expected)

    await expect(activation.resumeObserved(observed)).resolves.toBe(expected)
    expect(resolve).toHaveBeenCalledWith('selected')
    await resume.mock.calls[0]![0].setup?.(ctx, expected.agent)
    expect(mount).toHaveBeenCalledWith(ctx, 'selected')
    await expect(activation.compose(undefined)).resolves.toMatchObject({ agentPreset: 'default' })
  })

  it('keeps unselected Agents on the latest deployment model defaults', async () => {
    const { activation, select } = await harness()
    const options = activation.defaultOptions()
    expect(options.model).toBe('first')
    select({ provider: 'another', model: 'second' })
    expect(options).toMatchObject({ provider: 'another', model: 'second' })
  })

  it('requires a projection snapshot instead of using the original preset', async () => {
    const { activation } = await harness()
    const { projections: _projections, ...observed } = observation({ agentPreset: 'initial' })
    expect(() => activation.presetForObservation(observed)).toThrow(
      'Agent activation requires a projected Session observation',
    )
  })

  it('rejects subagent ownership before resolving the preset or opening a writer', async () => {
    const { ctx, activation } = await harness()
    const compose = vi.spyOn(activation, 'compose')
    const resume = vi.spyOn(ctx.agents, 'resume')

    await expect(activation.resumeObserved(observation({ origin: 'subagent' }))).rejects.toMatchObject({
      name: 'SessionControlError', code: 'SESSION_CONTROL_SUBAGENT_OWNED',
    })
    expect(compose).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('rechecks subagent ownership after asynchronous preset resolution', async () => {
    const { ctx, activation } = await harness()
    const observed = observation()
    const resolving = Promise.withResolvers<{ id: string }>()
    const resolve = vi.fn(() => resolving.promise)
    ctx.provide('agentPresets', { resolve } satisfies Pick<Context['agentPresets'], 'resolve'>)
    const resume = vi.spyOn(ctx.agents, 'resume')

    const work = activation.resumeObserved(observed)
    expect(resolve).toHaveBeenCalledOnce()
    ctx.sessions.create(observed.header.id, { meta: { origin: 'subagent', parentSession: SessionId('parent') } })
    resolving.resolve({ id: 'default' })
    await expect(work).rejects.toMatchObject({ code: 'SESSION_CONTROL_SUBAGENT_OWNED' })
    expect(resume).not.toHaveBeenCalled()
  })

  it('cancels before acquisition and after preset resolution without opening a writer', async () => {
    const { ctx, activation } = await harness()
    const cancellation = new AbortController()
    const failure = new Error('cancel activation')
    cancellation.abort(failure)
    const resume = vi.spyOn(ctx.agents, 'resume')
    await expect(activation.resumeObserved(observation(), cancellation.signal)).rejects.toBe(failure)

    const inFlight = new AbortController()
    const resolving = Promise.withResolvers<{ id: string }>()
    const resolve = vi.fn(() => resolving.promise)
    ctx.provide('agentPresets', { resolve } satisfies Pick<Context['agentPresets'], 'resolve'>)
    const work = activation.resumeObserved(observation(), inFlight.signal)
    expect(resolve).toHaveBeenCalledOnce()
    inFlight.abort(failure)
    resolving.resolve({ id: 'default' })
    await expect(work).rejects.toBe(failure)
    expect(resume).not.toHaveBeenCalled()
  })
})
