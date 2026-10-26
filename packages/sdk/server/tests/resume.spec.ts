import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonRpcTransportPeer, SessionEventNotification } from '@deepseek-ai/dsh-sdk-protocol'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sdk-resume-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function runtime(root: string, persistence = true, reasoning?: LlmModelReasoningInfo) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  if (persistence) await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('remembered')], reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)
  const events: SessionEventNotification[] = []
  const transport: JsonRpcTransportPeer = {
    request: async () => { throw new Error('unexpected server request') },
    notify: (method, params) => {
      if (method === 'session.event') events.push(params as SessionEventNotification)
    },
  }
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  cleanups.push(() => server.shutdown().then(() => {}))
  return { ctx, server, adapter, events }
}

async function initialized(root: string) {
  const result = await runtime(root)
  await result.server.initialize({ cwd: root, provider: 'mock', model: 'mock' })
  return result
}

describe('SDK persisted session resume', () => {
  it.each([
    { model: 'mock', effort: undefined, expected: 'high' },
    { model: 'other', effort: undefined, expected: undefined },
    { model: 'mock', effort: 'low', expected: 'low' },
  ])('applies the initialized route and effort on resume: $model / $effort', async ({ model, effort, expected }) => {
    const root = await storageRoot()
    const first = await initialized(root)
    await first.server.prompt({ sessionId: 'saved-effort', contentBlocks: [{ type: 'text', text: 'remember' }] })
    await first.server.wait({ sessionId: 'saved-effort' })
    first.ctx.agents.get(SessionId('saved-effort'))!.model.select({
      provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('high'),
    })
    await first.server.shutdown()
    await first.ctx.fiber.dispose()

    const second = await runtime(root, true, {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }, { id: ReasoningEffortId('low'), name: 'Low' }],
    })
    await second.server.initialize({
      cwd: root, provider: 'mock', model,
      ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
    })
    await second.server.resume({ sessionId: 'saved-effort' })
    expect(second.ctx.agents.get(SessionId('saved-effort'))!.model.current()).toEqual({
      provider: 'mock', model,
      ...expected === undefined ? {} : { reasoningEffort: expected },
    })
  })

  it('restores due reminders through the SDK owner after initialization and shares client resume', async () => {
    const root = await storageRoot()
    const first = await initialized(root)
    await first.server.prompt({ sessionId: 'saved', contentBlocks: [{ type: 'text', text: 'original' }] })
    await first.server.wait({ sessionId: 'saved' })
    await first.server.shutdown()
    await first.ctx.fiber.dispose()

    const { ctx, server, adapter } = await runtime(root)
    const fallback = vi.fn(async () => { throw new Error('must not activate through the Web controller') })
    const restoring = ctx.waterfall('schedule/resolve-agent', SessionId('saved'), fallback)
    expect(ctx.agents.list()).toHaveLength(0)
    const actualOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const opened = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const open = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args)
      opened.resolve(undefined)
      await gate.promise
      return handle
    })
    try {
      await server.initialize({ cwd: tmpdir(), provider: 'mock', model: 'reminder-model', maxTokens: 1234 })
      await opened.promise
      const resuming = server.resume({ sessionId: 'saved' })
      const anotherReminder = ctx.waterfall('schedule/resolve-agent', SessionId('saved'), fallback)
      gate.resolve(undefined)
      const [agent, sameAgent] = await Promise.all([restoring, anotherReminder, resuming])
      expect(sameAgent).toBe(agent)
      expect(open).toHaveBeenCalledTimes(1)
      expect(fallback).not.toHaveBeenCalled()
      expect(agent.session.header.cwd).toBe(root)
      await server.prompt({ sessionId: 'saved', contentBlocks: [{ type: 'text', text: 'scheduled reminder' }] })
      await server.wait({ sessionId: 'saved' })
      expect(adapter.requests[0]).toMatchObject({ model: 'reminder-model', maxTokens: 1234 })
      await expect(server.resume({ sessionId: 'saved' })).rejects.toThrow('already open')
      await server.shutdown()
      expect(ctx.agents.list()).toHaveLength(0)
    } finally {
      gate.resolve(undefined)
    }
  })

  it('reuses an SDK-owned Session for reminders and releases failed reminder restoration for retry', async () => {
    const { ctx, server } = await initialized(await storageRoot())
    const fallback = vi.fn(async () => { throw new Error('unexpected fallback') })
    const restore = () => ctx.waterfall('schedule/resolve-agent', SessionId('saved'), fallback)
    await expect(restore()).rejects.toThrow()
    await server.prompt({ sessionId: 'saved', contentBlocks: [{ type: 'text', text: 'create after failed reminder' }] })
    await server.wait({ sessionId: 'saved' })
    const agent = ctx.agents.get(SessionId('saved'))
    await expect(restore()).resolves.toBe(agent)
    await expect(server.resume({ sessionId: 'saved' })).rejects.toThrow('already open')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('releases a reminder waiting for initialization when the SDK shuts down', async () => {
    const { ctx, server } = await runtime(await storageRoot())
    const restoring = ctx.waterfall('schedule/resolve-agent', SessionId('saved'), async () => {
      throw new Error('unexpected fallback')
    })
    const rejected = expect(restoring).rejects.toThrow('shutting down')
    await server.shutdown()
    await rejected
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('restores a non-main identity, preserves history and origin, and appends a new turn', async () => {
    const root = await storageRoot()
    const first = await initialized(root)
    await first.server.prompt({ sessionId: 'saved-session', contentBlocks: [{ type: 'text', text: 'remember kiwi' }] })
    await first.server.wait({ sessionId: 'saved-session' })
    const original = first.ctx.agents.get(SessionId('saved-session'))!.session.snapshotEvents()
    await first.server.shutdown()
    await first.ctx.fiber.dispose()

    const second = await runtime(root)
    await second.server.initialize({ cwd: tmpdir(), provider: 'mock', model: 'resumed-model', maxTokens: 123 })
    await expect(second.server.handleRequest('session/resume', { sessionId: 'saved-session' }))
      .resolves.toEqual({})
    const restored = second.ctx.agents.get(SessionId('saved-session'))!.session
    expect(restored.header.cwd).toBe(root)
    expect(restored.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(restored.snapshotEvents().slice(original.length)).toMatchObject([
      { type: 'session/end-seed' },
      { type: 'model/selection', data: { provider: 'mock', model: 'resumed-model' } },
    ])
    expect(second.adapter.requests).toHaveLength(0)
    expect(second.events).toEqual([
      { sessionId: 'saved-session', event: restored.snapshotEvents().at(-1) },
    ])
    await second.server.prompt({ sessionId: 'saved-session', contentBlocks: [{ type: 'text', text: 'what did I say?' }] })
    await second.server.wait({ sessionId: 'saved-session' })
    expect(second.events.length).toBeGreaterThan(0)
    expect(second.events.every(notification => notification.event.seq > original.at(-1)!.seq)).toBe(true)
    const request = JSON.stringify(second.adapter.requests[0])
    expect(request).toContain('remember kiwi')
    expect(request).toContain('remembered')
    expect(request).toContain('what did I say?')
    expect(second.adapter.requests[0]).toMatchObject({ model: 'resumed-model', maxTokens: 123 })
    expect(restored.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(restored.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
    await expect(second.server.resume({ sessionId: 'saved-session' })).rejects.toThrow('already open')
  })

  it('repairs an interrupted final turn before accepting new input', async () => {
    const root = await storageRoot()
    const first = await initialized(root)
    await first.server.prompt({ sessionId: 'interrupted', contentBlocks: [{ type: 'text', text: 'first turn' }] })
    await first.server.wait({ sessionId: 'interrupted' })
    await first.server.shutdown()
    const handle = await first.ctx.sessionPersistence.open(SessionId('interrupted'), 'write')
    try {
      const events = (await handle.read()).events
      const last = events.at(-1)!
      await handle.append([
        { type: 'turn/start', data: { turn: 2 }, seq: SessionSeq(last.seq + 1), time: last.time + 1 },
        { type: 'step/start', data: { turn: 2, step: 1 }, seq: SessionSeq(last.seq + 2), time: last.time + 2 },
      ])
      await handle.flush()
    } finally {
      await handle.close()
    }
    await first.ctx.fiber.dispose()
    const second = await initialized(root)
    await second.server.resume({ sessionId: 'interrupted' })
    const restored = second.ctx.agents.get(SessionId('interrupted'))!.session
    expect(restored.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)).toMatchObject({
      type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } },
    })
    await second.server.prompt({ sessionId: 'interrupted', contentBlocks: [{ type: 'text', text: 'continue' }] })
    await second.server.wait({ sessionId: 'interrupted' })
    expect(restored.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } },
    })
  })

  it('rejects missing history and releases a failed resume for retry', async () => {
    const { ctx, server } = await initialized(await storageRoot())
    await expect(server.resume({ sessionId: 'missing' })).rejects.toThrow()
    await expect(server.resume({ sessionId: 'missing' })).rejects.toThrow()
    expect(ctx.agents.list()).toHaveLength(0)
    expect(ctx.sessions.get(SessionId('missing'))).toBeUndefined()
  })

  it('shares pending restoration with a prompt and rejects duplicate resume', async () => {
    const root = await storageRoot()
    const first = await initialized(root)
    await first.server.prompt({ sessionId: 'saved', contentBlocks: [{ type: 'text', text: 'original' }] })
    await first.server.wait({ sessionId: 'saved' })
    await first.server.shutdown()
    await first.ctx.fiber.dispose()
    const { ctx, server } = await initialized(root)
    const actualOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const gate = Promise.withResolvers<undefined>()
    const opened = Promise.withResolvers<undefined>()
    const open = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      opened.resolve(undefined)
      await gate.promise
      return actualOpen(...args)
    })
    try {
      const restoring = server.resume({ sessionId: 'saved' })
      await opened.promise
      await expect(server.resume({ sessionId: 'saved' })).rejects.toThrow('already open or opening')
      const prompting = server.prompt({ sessionId: 'saved', contentBlocks: [{ type: 'text', text: 'followup' }] })
      gate.resolve(undefined)
      await restoring
      await prompting
      await server.wait({ sessionId: 'saved' })
      expect(open).toHaveBeenCalledTimes(1)
      expect(ctx.agents.list()).toHaveLength(1)
      await server.shutdown()
      expect(ctx.agents.list()).toHaveLength(0)
      await expect(server.resume({ sessionId: 'saved' })).rejects.toThrow('shutting down')
    } finally {
      gate.resolve(undefined)
    }
  })

  it('waits for pending restoration during shutdown and releases the restored Agent', async () => {
    const root = await storageRoot()
    const first = await initialized(root)
    await first.server.prompt({ sessionId: 'saved', contentBlocks: [{ type: 'text', text: 'original' }] })
    await first.server.wait({ sessionId: 'saved' })
    await first.server.shutdown()
    await first.ctx.fiber.dispose()
    const { ctx, server } = await initialized(root)
    const actualOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const gate = Promise.withResolvers<undefined>()
    const opened = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      opened.resolve(undefined)
      await gate.promise
      return actualOpen(...args)
    })
    try {
      const restoring = server.resume({ sessionId: 'saved' })
      await opened.promise
      const shutdown = server.shutdown()
      await expect(server.resume({ sessionId: 'another' })).rejects.toThrow('shutting down')
      gate.resolve(undefined)
      await Promise.all([restoring, shutdown])
      expect(ctx.agents.list()).toHaveLength(0)
    } finally {
      gate.resolve(undefined)
    }
  })

  it('rejects restoration when the profile has no persistence backend', async () => {
    const root = await storageRoot()
    const { ctx, server } = await runtime(root, false)
    await server.initialize({ cwd: root, provider: 'mock', model: 'mock' })
    await expect(server.resume({ sessionId: 'saved' })).rejects.toThrow('session persistence is not configured')
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('validates the wire identity and requires initialization', async () => {
    const { server } = await runtime(await storageRoot())
    for (const sessionId of [undefined, '', 17]) {
      await expect(server.handleRequest('session/resume', { sessionId })).rejects.toThrow('non-empty sessionId')
    }
    await expect(server.resume({ sessionId: 'saved' })).rejects.toThrow('not initialized')
  })
})
