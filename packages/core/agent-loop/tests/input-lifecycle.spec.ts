import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentClosedError, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const fixtures: { ctx: Context; agent?: Agent; root: string }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
      await fixture.agent?.whenIdle()
      await fixture.ctx.fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

const input = (text: string) => createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })

async function harness() {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-input-atomicity-'))
  const fixture: { ctx: Context; agent?: Agent; root: string } = { ctx, root }
  fixtures.push(fixture)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(CheckpointPolicy)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(Array.from({ length: 5 }, () => textResponse('ok')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('diagnostic'), agentOptions: { provider: 'mock', model: 'mock' } })
  fixture.agent = handle.agent
  return { ctx, root, adapter, handle, agent: handle.agent }
}

it('cancellation still aborts the running request when queue clearing fails', async () => {
  const { ctx, agent } = await harness()
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  const hold = ctx.on('agent/pre-step', async ({ signal }, next) => { entered.resolve(signal); await release.promise; return next() })
  let stopRejecting = () => {}
  try {
    agent.followup(input('running'))
    const signal = await entered.promise
    agent.inject(input('steering'))
    const queued = input('queued')
    agent.followup(queued)
    stopRejecting = ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      if (session === agent.session && event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn'
        && (event.data.removedCount ?? 0) > 0) throw new Error('injected queue clear failure')
    })
    expect(() => { agent.cancel({ kind: 'user' }) }).toThrow('injected queue clear failure')
    expect(signal.aborted).toBe(true)
    expect(agent.inbox.nextTurn).toEqual([queued])
  } finally {
    stopRejecting()
    hold()
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    release.resolve(undefined)
    await agent.whenIdle()
  }
})

it('an Agent still in the registry rejects new input while its owner is closing', async () => {
  const { ctx, agent, handle } = await harness()
  const release = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const work = agent.runMaintenance(async (signal) => {
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    await release.promise
  })
  const closing = handle.dispose()
  try {
    await aborted.promise
    expect(ctx.agents.get(agent.id)).toBe(agent)
    const message = input('during closing')
    const error = vi.fn((failure: unknown) => failure)
    try {
      agent.followup(message)
    } catch (failure) {
      error(failure)
    }
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      name: 'AgentClosedError', code: 'AGENT_CLOSED', agentId: agent.id,
    }))
    expect(error.mock.calls[0]?.[0]).toBeInstanceOf(HarnessError)
    for (const submit of [() => { agent.followup(message) }, () => { agent.steer(message) }, () => { agent.inject(message) }, () => { agent.send(message, 'next-turn', true) }, () => agent.runMaintenance(async () => {}), () => { agent.inbox.append('next-turn', message) }, () => { agent.inbox.prepend('next-step', message) }, () => agent.inbox.splice('next-turn', 0, 0, [message]), () => agent.inbox.replace(message.id, message)]) {
      expect(submit).toThrow(AgentClosedError)
    }
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(entry => entry.id === message.id)
    expect(pending).toBe(false)
  } finally {
    release.resolve(undefined)
    await work
    await closing
  }
})

it('waits for admitted maintenance after a queue-clear failure before releasing its Session', async () => {
  const { ctx, agent, handle } = await harness()
  const release = Promise.withResolvers<undefined>()
  const waiting = Promise.withResolvers<'waiting'>()
  const disposed = Promise.withResolvers<'disposed'>()
  let scopeDisposed = false
  agent.ctx.effect(() => () => { scopeDisposed = true; disposed.resolve('disposed') })
  const work = agent.runMaintenance(async () => {
    await release.promise
    agent.session.append('request/context', { provider: 'mock', model: 'mock' })
  })
  agent.inject(input('pending'))
  const stopRejecting = ctx.on('internal/dispatch', (_mode, name, args) => {
    if (name !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (session === agent.session && event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) > 0) {
      throw new Error('queue clear failed')
    }
  })
  const whenIdle = agent.whenIdle.bind(agent)
  const spy = vi.spyOn(agent, 'whenIdle').mockImplementation(() => { waiting.resolve('waiting'); return whenIdle() })
  const closing = handle.dispose().then(() => undefined, (error: unknown) => error)
  try {
    expect(await Promise.race([waiting.promise, disposed.promise])).toBe('waiting')
    expect(scopeDisposed).toBe(false)
    expect(ctx.sessions.get(agent.id)).toBe(agent.session)
    release.resolve(undefined)
    await work
    expect(await closing).toEqual(new Error('queue clear failed'))
    expect(scopeDisposed).toBe(true)
    expect(agent.session.snapshotEvents().at(-1)?.type).toBe('request/context')
  } finally {
    stopRejecting()
    spy.mockRestore()
    release.resolve(undefined)
    await work
    await closing
  }
})

it('does not start a driver when an inbox observer closes its owner during admission', async () => {
  const { ctx, agent, handle, adapter } = await harness()
  let closing: Promise<void> | undefined
  const stop = ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'user') closing = handle.dispose()
  })
  try {
    agent.followup(input('close during admission'))
    expect(closing).toBeDefined()
    await closing
    expect(adapter.requests).toHaveLength(0)
  } finally {
    stop()
    await closing
  }
})

it('reports a quiescence failure while releasing the Agent and Session', async () => {
  const { ctx, agent, handle } = await harness()
  const failure = new Error('injected quiescence failure')
  const idle = vi.spyOn(agent, 'whenIdle').mockRejectedValueOnce(failure)
  try {
    await expect(handle.dispose()).rejects.toThrow('injected quiescence failure')
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(ctx.sessions.get(agent.id)).toBeUndefined()
  } finally {
    idle.mockRestore()
  }
})

it('keeps creation resources alive until an interrupted creation listener finishes', async () => {
  const { ctx } = await harness()
  const entered = Promise.withResolvers<Agent>()
  const release = Promise.withResolvers<undefined>()
  const signal = new AbortController()
  const id = SessionId('interrupted-announcement')
  const stop = ctx.on('agent/created', async ({ agent }) => {
    if (agent.id !== id) return
    entered.resolve(agent)
    await release.promise
  })
  const creation = ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' }, signal: signal.signal })
    .then(handle => handle.dispose(), (error: unknown) => error)
  try {
    const agent = await entered.promise
    signal.abort(new Error('creation interrupted'))
    expect(ctx.sessions.get(id)).toBe(agent.session)
    release.resolve(undefined)
    expect(await creation).toEqual(new Error('creation interrupted'))
    expect(ctx.sessions.get(id)).toBeUndefined()
  } finally {
    release.resolve(undefined)
    await creation
    stop()
  }
})
