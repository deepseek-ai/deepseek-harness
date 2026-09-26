/** Session Controller fork boundaries, lineage, and inherited model routing. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ToolCallId, createMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import SessionStore, { TOOL_OUTCOME_UNKNOWN, SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  createSessionTestRemote, installSessionReadTestServices, testSessionPersistence,
} from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId
const message = (text: string) => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user' },
})

function request<P>(payload: P): P {
  return payload
}

async function composed(workspaces: readonly Workspace[] = []): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', { list: () => workspaces, archivedSessionIds: [] } as never)
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
      const agentCtx = ownerCtx
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await options.setup?.(agentCtx, agent)
      await ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('fork test sources are live')),
  })
  return ctx
}

/** Tail turn appended after the completed ones: left open, or closed as aborted (a stopped turn). */
type Tail = 'none' | 'open' | 'aborted'

async function liveAgent(
  ctx: Context,
  id: string,
  turns: number,
  tail: Tail = 'none',
  lineage: { parentSession?: SessionId; origin?: 'subagent' } = {},
): Promise<Session> {
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
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

describe('sessions.fork', () => {
  it('keeps the completed manual compaction checkpoint when atSeq is omitted', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      const harness = await mountAgentLoopTestHarness(ctx)
      await ctx.plugin(TokenMeter)
      const compact = new BasicCompactionEngine(ctx, { auto: false })
      const adapter = new MockAdapter([
        textResponse('reply'), textResponse('checkpoint'), textResponse('continued'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
      const source = await harness.create(sid('manual-compaction-source'), { provider: 'mock', model: 'mock' })
      const originalPrompt = 'older conversation history '.repeat(60)
      source.followup(message(originalPrompt))
      await source.whenIdle()
      expect(await compact.compactNow(source, new AbortController().signal)).not.toBeNull()
      const compacted = source.session.snapshotEvents()
      expect(compacted.at(-1)).toMatchObject({ type: 'compaction/end', data: { turn: null } })
      source.inbox.append('next-turn', message('queued after compaction'))

      const response = await createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp',
      }).fork({ sessionId: source.id })

      if (!response.ok) throw response.error
      const child = ctx.agents.get(response.value.sessionId)!
      expect(child.session.inheritedEventCount).toBe(compacted.length)
      expect(child.session.snapshotEvents().slice(0, child.session.inheritedEventCount)).toEqual(compacted)
      expect(child.session.deriveMessages()).toEqual(source.session.deriveMessages())
      child.followup(message('continue from checkpoint'))
      await child.whenIdle()
      const requestText = JSON.stringify(adapter.requests.at(-1)?.messages)
      expect(requestText).toContain('checkpoint')
      expect(requestText).toContain('continue from checkpoint')
      expect(requestText).not.toContain(originalPrompt)
      expect(requestText).not.toContain('queued after compaction')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['turn-end', 'omitted'] as const)(
    'excludes the next user input when forking at %s', async (anchor) => {
      const ctx = new Context()
      try {
        await mountAgentLoopTestDependencies(ctx)
        const harness = await mountAgentLoopTestHarness(ctx)
        const adapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('reply')))
        ctx.llm.registerAdapter(['mock'], adapter)
        ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
        const source = await harness.create(sid('source'), { provider: 'mock', model: 'mock' })
        source.followup(message('A'))
        await source.whenIdle()
        const boundary = source.session.snapshotEvents().at(-1)!.seq
        if (anchor === 'turn-end') {
          source.followup(message('B'))
          await source.whenIdle()
        } else {
          source.inbox.append('next-turn', message('B'))
        }
        const original = source.session.snapshotEvents()
        const atSeq = anchor === 'omitted' ? undefined : boundary
        const response = await createSessionTestRemote(ctx, {
          defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp',
        }).fork({ sessionId: source.id, ...(atSeq === undefined ? {} : { atSeq }) })
        if (!response.ok) throw response.error
        const child = ctx.agents.get(response.value.sessionId)!
        const requestCount = adapter.requests.length
        child.followup(message('C'))
        await child.whenIdle()
        const userTexts = child.session.deriveMessages().flatMap(item => item.role === 'user'
          ? item.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
        expect(userTexts).toEqual(['A', 'C'])
        expect(adapter.requests.slice(requestCount)).toHaveLength(1)
        expect(child.session.inheritedEventCount).toBe(boundary + 1)
        expect(source.session.snapshotEvents()).toEqual(original)
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('cuts exactly at a completed turn and records lineage and cwd', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-source', 2)
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: 2 }))
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
    const owner = await liveAgent(ctx, 'session-owner', 1)
    accounted.push(owner.id)
    const child = await liveAgent(ctx, 'session-child', 1, 'none', {
      parentSession: owner.id,
      origin: 'subagent',
    })
    const grandchild = await liveAgent(ctx, 'session-grandchild', 1, 'none', {
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

    expect(response.ok ? undefined : response.error).toBeUndefined()
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

    expect(response.ok ? undefined : response.error).toBeUndefined()
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

  it('uses the latest completed prefix only when atSeq is omitted', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-tail', 2, 'open')
    const proxy = remote(ctx)
    const omitted = await proxy.fork(request({ sessionId: source.id }))
    expect(omitted.ok).toBe(true)
    if (omitted.ok) {
      expect(ctx.sessions.get(omitted.value.sessionId)?.snapshotEvents().map(event => event.type))
        .toEqual([
          'turn/start', 'user/message', 'turn/end',
          'turn/start', 'user/message', 'turn/end',
          'session/end-seed',
        ])
    }
    const pastEnd = await proxy.fork(request({ sessionId: source.id, atSeq: 999 }))
    expect(pastEnd).toMatchObject({
      ok: false,
      error: { code: 'session/fork-unavailable', details: { sessionId: source.id } },
    })
    if (!pastEnd.ok) expect(pastEnd.error.message).toMatch(/does not exist/)
    await ctx.fiber.dispose()
  })

  it('rejects an omitted boundary when no turn has completed', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-never-completed', 0, 'open')
    const response = await remote(ctx).fork(request({ sessionId: source.id }))
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/fork-unavailable', details: { sessionId: source.id } },
    })
    if (!response.ok) expect(response.error.message).toMatch(/no completed turn/)
    await ctx.fiber.dispose()
  })

  it.each([false, true])('inherits standalone tail events with the next turn open: %s', async (openNextTurn) => {
    const ctx = await composed()
    try {
      const source = await liveAgent(ctx, 'session-standalone-tail', 1)
      source.append('session/title', { title: 'After the turn', messageSeqs: [], source: { kind: 'user' } })
      const inherited = source.snapshotEvents()
      if (openNextTurn) source.append('turn/start', { turn: 2 })

      const response = await remote(ctx).fork({ sessionId: source.id })

      if (!response.ok) throw response.error
      const child = ctx.sessions.get(response.value.sessionId)!
      expect(child.inheritedEventCount).toBe(inherited.length)
      expect(child.snapshotEvents().slice(0, child.inheritedEventCount)).toEqual(inherited)
      expect(child.snapshotEvents().slice(child.inheritedEventCount).map(event => event.type))
        .toEqual(['session/end-seed'])
    } finally {
      await ctx.fiber.dispose()
    }
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

  it('cuts before an aborted turn/end and synthesizes a forked closer', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-aborted', 1, 'aborted')
    const anchor = (source.snapshotEvents().at(-1)?.seq ?? 0) - 1
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: anchor }))
    expect(response.ok ? undefined : response.error).toBeUndefined()
    if (!response.ok) return
    const child = ctx.sessions.get(response.value.sessionId)
    expect(child?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'session/end-seed', 'turn/end',
    ])
    const closer = child?.snapshotEvents().at(-1)
    expect(closer?.type === 'turn/end' && closer.data.reason).toEqual({ kind: 'forked' })
    await ctx.fiber.dispose()
  })

  it('cuts exactly inside a live open turn and preserves the source', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-open', 1, 'open')
    const boundary = source.snapshotEvents().at(-1)?.seq ?? 0
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: boundary }))
    expect(response.ok ? undefined : response.error).toBeUndefined()
    if (!response.ok) return
    const child = ctx.sessions.get(response.value.sessionId)
    expect(child?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'session/end-seed', 'turn/end',
    ])
    const closer = child?.snapshotEvents().at(-1)
    expect(closer?.type === 'turn/end' && closer.data.reason).toEqual({ kind: 'forked' })
    expect(child?.inheritedEventCount).toBe(boundary + 1)
    expect(source.snapshotEvents().at(-1)?.type).toBe('user/message')
    await ctx.fiber.dispose()
  })

  it('does not extend an explicit boundary through standalone tail events', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-exact', 1)
    const boundary = source.snapshotEvents().at(-1)?.seq ?? 0
    source.append('session/title', { title: 'after boundary', messageSeqs: [], source: { kind: 'fallback' } })

    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: boundary }))

    expect(response.ok ? undefined : response.error).toBeUndefined()
    if (!response.ok) return
    expect(ctx.sessions.get(response.value.sessionId)?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'session/end-seed',
    ])
    await ctx.fiber.dispose()
  })

  it('repairs a cold open-step cut without resuming its Agent', async () => {
    const ctx = await composed()
    const sourceId = sid('session-cold-mid-turn')
    const callId = ToolCallId('cold-dangling')
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sourceId, createdAt: 1, cwd: '/proj', isSeeded: false }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'user/message',
        seq: 2,
        time: 3,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      {
        type: 'assistant/message',
        seq: 3,
        time: 4,
        data: {
          stream: [],
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
            source: { kind: 'model', provider: 'mock', model: 'mock' },
          }),
        },
        surfaceOp: 'append',
      },
      { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId, name: 'read', arguments: '{}' } },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      {
        type: 'turn/end',
        seq: 6,
        time: 7,
        data: { turn: 1, reason: { kind: 'error', error: { message: 'scheduler failed', code: 'UNKNOWN' } } },
      },
    ] as SessionEvent[]
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, events }),
    }) as never)
    const resume = vi.spyOn(ctx.agents, 'resume')

    const response = await remote(ctx).fork(request({ sessionId: sourceId, atSeq: 4 }))

    expect(response.ok ? undefined : response.error).toBeUndefined()
    if (!response.ok) return
    expect(resume).not.toHaveBeenCalled()
    const child = ctx.sessions.get(response.value.sessionId)
    expect(child?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message',
      'tool/call', 'session/end-seed', 'tool/result', 'step/end', 'turn/end',
    ])
    expect(child?.inheritedEventCount).toBe(5)
    expect(child?.snapshotEvents().at(-3)).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { source: { callId } },
        error: { code: TOOL_OUTCOME_UNKNOWN },
      },
      sourceEventSeqs: [4],
    })
    const closer = child?.snapshotEvents().at(-1)
    expect(closer?.type === 'turn/end' && closer.data.reason).toEqual({ kind: 'forked' })
    expect(child?.deriveMessages().at(-1)).toMatchObject({ source: { kind: 'tool', callId } })
    await ctx.fiber.dispose()
  })

  it('inherits model selection through the completed turn and excludes later changes', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-routed', 0)
    source.append('turn/start', { turn: 1 })
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
    const boundary = source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const inherited = source.snapshotEvents()
    source.append('session/title', {
      title: 'Title after the selected turn', messageSeqs: [], source: { kind: 'user' },
    })
    source.append('turn/start', { turn: 2 })
    source.append('request/header', {
      header: { config: { provider: 'later-provider', model: 'later-model' } },
      reason: 'change',
    })
    source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const response = await remote(ctx).fork(request({ sessionId: source.id, atSeq: boundary.seq }))
    expect(response.ok ? undefined : response.error).toBeUndefined()
    if (!response.ok) return
    const child = ctx.agents.get(response.value.sessionId)
    if (child === undefined) throw new Error('fork did not publish the child agent')
    expect(child.session.snapshotEvents().slice(0, child.session.inheritedEventCount)).toEqual(inherited)
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
