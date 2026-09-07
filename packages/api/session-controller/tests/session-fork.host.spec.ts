/** Session Controller fork boundaries, lineage, and inherited model routing. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  createSessionTestRemote, installSessionReadTestServices, testSessionPersistence,
} from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

async function composed(workspaces: readonly Workspace[] = []): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.inheritedEventCount === undefined
          ? {}
          : { inheritedEventCount: options.inheritedEventCount },
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('fork test sources are live')),
  })
  return ctx
}

/** Tail turn appended after the completed ones: left open, or closed as aborted (a stopped turn). */
type Tail = 'none' | 'open' | 'aborted'

function liveAgent(
  ctx: Context,
  id: string,
  turns: number,
  tail: Tail = 'none',
  lineage: { parentSession?: SessionId; origin?: 'subagent' } = {},
): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj', ...lineage } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (tail !== 'none') {
    session.append('turn/start', { turn: turns + 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (tail === 'aborted') session.append('turn/end', {
      turn: turns + 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
  }
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

describe('sessions.fork', () => {
  it('cuts at the anchored completed turn and records lineage and cwd', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-source', 2)
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: 1 }))
    expect(response.ok ? null : response.error).toBeNull()
    if (!response.ok) return
    const child = ctx.sessions.get(response.value.sessionId)
    expect(child?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'session/end-seed',
    ])
    expect(child?.header.parentSession).toBe(source.id)
    expect(child?.header.cwd).toBe('/proj')
    await ctx.fiber.dispose()
  })

  it('attaches a subagent fork to its nearest workspace-owning ancestor', async () => {
    const accounted: SessionId[] = []
    const attachSession = vi.fn<(sessionId: SessionId) => Promise<void>>()
      .mockResolvedValue(undefined)
    const workspace = {
      sessionIds: accounted,
      attachSession,
    } as unknown as Workspace
    const ctx = await composed([workspace])
    const owner = liveAgent(ctx, 'session-owner', 1)
    accounted.push(owner.id)
    const child = liveAgent(ctx, 'session-child', 1, 'none', {
      parentSession: owner.id,
      origin: 'subagent',
    })
    const grandchild = liveAgent(ctx, 'session-grandchild', 1, 'none', {
      parentSession: child.id,
      origin: 'subagent',
    })
    vi.spyOn(ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: { header: grandchild.header, live: true, persisted: false },
      ancestors: [
        { header: child.header, live: true, persisted: false },
        { header: owner.header, live: true, persisted: false },
      ],
      descendants: [],
      complete: true,
      root: { header: owner.header, live: true, persisted: false },
    })

    const response = await remote(ctx).fork(request({ sessionId: grandchild.id }))

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(attachSession).toHaveBeenCalledWith(response.value.sessionId)
    expect(ctx.sessions.get(response.value.sessionId)?.header).toMatchObject({
      parentSession: grandchild.id,
      cwd: '/proj',
    })
    expect(ctx.sessions.get(response.value.sessionId)?.header.origin).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forks a persisted subagent without resuming its Agent', async () => {
    const ctx = await composed()
    const sourceId = sid('session-cold-subagent')
    const parentId = sid('session-cold-parent')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sourceId,
      createdAt: 1,
      cwd: '/proj',
      parentSession: parentId,
      isSeeded: false,
      origin: 'subagent',
    }
    const events = [
      {
        type: 'turn/start',
        seq: SessionSeq(0),
        time: 1,
        data: {
          turn: 1,
          trigger: { kind: 'message', source: { kind: 'user' } },
        } as SessionEvent<'turn/start'>['data'],
      },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] satisfies SessionEvent[]
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({
        meta: header,
        inheritedEventCount: SessionLogOffset(0),
        events,
      }),
    }) as never)
    const resume = vi.spyOn(ctx.agents, 'resume')

    const response = await remote(ctx).fork(request({ sessionId: sourceId }))

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(resume).not.toHaveBeenCalled()
    expect(ctx.agents.get(sourceId)).toBeUndefined()
    expect(ctx.sessions.get(response.value.sessionId)?.header).toMatchObject({
      parentSession: sourceId,
      cwd: '/proj',
    })
    expect(ctx.sessions.get(response.value.sessionId)?.header.origin).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('uses the last completed turn only for omitted and past-end anchors', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-tail', 2, 'open')
    const proxy = remote(ctx)
    const expectedTypes = [
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed',
    ]
    const omitted = await proxy.fork(request({ sessionId: source.id }))
    expect(omitted.ok).toBe(true)
    if (omitted.ok) {
      expect(ctx.sessions.get(omitted.value.sessionId)?.snapshotEvents().map(event => event.type))
        .toEqual(expectedTypes)
    }
    const pastEnd = await proxy.fork(request({ sessionId: source.id, atSeq: 999 }))
    expect(pastEnd.ok).toBe(true)
    if (pastEnd.ok) {
      expect(ctx.sessions.get(pastEnd.value.sessionId)?.snapshotEvents().map(event => event.type))
        .toEqual(expectedTypes)
    }
    await ctx.fiber.dispose()
  })

  it('rejects invalid fork anchors before reading or creating a Session', async () => {
    const ctx = await composed()
    const proxy = remote(ctx)

    for (const atSeq of [-1, 0.5]) {
      await expect(proxy.fork(request({ sessionId: sid('missing'), atSeq })))
        .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    }
    expect(ctx.sessions.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('cuts through an aborted turn: stopped is closed, not open', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-aborted', 1, 'aborted')
    // What a stopped message's fork button anchors on: the frozen node sits
    // one event before its turn/end, floored client-side to that event's seq.
    const anchor = (source.snapshotEvents().at(-1)?.seq ?? 0) - 1
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: anchor }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(ctx.sessions.get(response.value.sessionId)?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed',
    ])
    await ctx.fiber.dispose()
  })

  it('rejects an in-log anchor whose turn is still open', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-open', 1, 'open')
    const anchor = source.snapshotEvents().at(-1)?.seq ?? 0
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: anchor }))
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/fork-unavailable', details: { sessionId: source.id } },
    })
    if (!response.ok) expect(response.error.message).toMatch(/has not completed/)
    await ctx.fiber.dispose()
  })

  it('installs the latest logged model selection before the child can run', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-routed', 1)
    source.append('request/header', {
      header: {
        config: {
          provider: 'inherited-provider',
          model: 'inherited-model',
          reasoningEffort: ReasoningEffortId('high'),
        },
      },
      reason: 'initial',
    })
    const response = await remote(ctx).fork(request({ sessionId: source.id }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const child = ctx.agents.get(response.value.sessionId)
    if (child === undefined) throw new Error('fork did not publish the child agent')
    const assembly = await child.ctx.systemPrompt.assemble()
    expect(assembly.variables).toMatchObject({
      provider: 'inherited-provider',
      model: 'inherited-model',
    })
    const fallback: LlmCallConfig = { provider: 'default-provider', model: 'default-model' }
    await expect(agentEvents(child.ctx, child).waterfall(
      'agent/request', { turn: 1, step: 0, signal: new AbortController().signal }, () => Promise.resolve(fallback),
    )).resolves.toMatchObject({
      provider: 'inherited-provider',
      model: 'inherited-model',
      reasoningEffort: 'high',
    })
    await ctx.fiber.dispose()
  })
})
