import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from '../../subagent/tests/local-activation.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import SubagentNames from '../src/index.ts'

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const namesFiber = await ctx.plugin(SubagentNames)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()), agentOptions: { provider: 'mock', model: 'mock' },
  })
  const parent = parentHandle.agent
  ctx.on('agent/pre-step', async ({ agent }, next) => agent.id === parent.id ? { kind: 'reject' } : next())
  const start = (creator: Agent = parent) => ctx.subagents.startActivation({
    provider: 'spawn', label: 'Review', parent: creator, delivery: 'parent',
    prompt: [{ type: 'text', text: 'Review the change' }], signal: new AbortController().signal,
  })
  return { ctx, parent, parentHandle, namesFiber, start }
}

describe('root Session name mappings', () => {
  it('binds an accepted child without changing its id, prompt, or execution', async () => {
    const { ctx, parent, start } = await setup([textResponse('done')])
    const reservation = ctx.subagentNames.reserve(parent, 'reviewer')
    const activation = await start()
    expect(ctx.subagentNames.nameOf(parent, activation.childId)).toBe(activation.childId)
    ctx.subagentNames.bind(parent, activation.childId, reservation.name)
    reservation.dispose()
    await activation.result

    expect(ctx.subagentNames.nameOf(parent)).toBe('lead')
    expect(ctx.subagentNames.nameOf(parent, activation.childId)).toBe('lead/reviewer')
    expect(ctx.subagentNames.resolveName(parent, 'lead')).toBe(parent.id)
    expect(ctx.subagentNames.resolveName(parent, 'lead/reviewer')).toBe(activation.childId)
    expect(ctx.subagentNames.resolveName(parent, activation.childId)).toBe(activation.childId)
    expect(ctx.subagentNames.resolveName(parent, 'unmapped-id')).toBe('unmapped-id')
    expect(() => ctx.subagentNames.resolveName(parent, 'lead/misspelled')).toThrow('was not found')
    const stored = await loadStoredSession(ctx.sessionPersistence, activation.childId)
    const message = stored.events.find(event => event.type === 'user/message')
    expect(message?.data.content[0]).toEqual({ type: 'text', text: 'Review the change' })
    expect(JSON.stringify(message)).not.toContain('Your name is')
    expect(stored.events.some(event => event.type === 'subagent-name/bound')).toBe(false)
  })

  it('reserves distinct defaults, rejects overlap, and reuses released unbound names', async () => {
    const { ctx, parent } = await setup()
    const first = ctx.subagentNames.reserve(parent)
    const second = ctx.subagentNames.reserve(parent)
    expect([first.name, second.name]).toEqual(['lead/agent-1', 'lead/agent-2'])
    expect(() => ctx.subagentNames.reserve(parent, 'agent-1')).toThrow('already in use')
    first.dispose()
    first.dispose()
    const retry = ctx.subagentNames.reserve(parent)
    expect(retry.name).toBe('lead/agent-1')
    first.dispose()
    expect(() => ctx.subagentNames.reserve(parent, 'agent-1')).toThrow('already in use')
    ctx.subagentNames.bind(parent, SessionId('accepted-child'), retry.name)
    retry.dispose()
    expect(() => ctx.subagentNames.reserve(parent, 'agent-1')).toThrow('already in use')
    second.dispose()
    const available = ctx.subagentNames.reserve(parent)
    expect(available.name).toBe('lead/agent-2')
    available.dispose()
  })

  it.each(['', 'Reviewer', 'lead/reviewer', 'two words', '1reviewer', 'legacy:child'])(
    'rejects invalid requested segment %j before reserving it', async (name) => {
      const { ctx, parent } = await setup()
      expect(() => ctx.subagentNames.reserve(parent, name)).toThrow('agent name must')
      expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toEqual([])
    },
  )

  it('keeps exact bindings idempotent while rejecting name and identity conflicts', async () => {
    const { ctx, parent } = await setup()
    const id = SessionId('accepted-child')
    expect(() => { ctx.subagentNames.bind(parent, id, 'reviewer') }).toThrow('complete lead/... path')
    ctx.subagentNames.bind(parent, id, 'lead/reviewer')
    const seq = parent.session.seq
    ctx.subagentNames.bind(parent, id, 'lead/reviewer')
    expect(parent.session.seq).toBe(seq)
    expect(() => { ctx.subagentNames.bind(parent, id, 'lead/renamed') }).toThrow('already bound')
    expect(() => { ctx.subagentNames.bind(parent, SessionId('another-child'), 'lead/reviewer') }).toThrow('already bound')
  })

  it('records nested aliases only on the root and restores them without ancestor reads', async () => {
    const { ctx, parent, parentHandle, start } = await setup(['hang', 'hang'])
    const creator = await start()
    ctx.subagentNames.bind(parent, creator.childId, 'lead/reviewer')
    const creatorAgent = ctx.agents.get(creator.childId)!
    const reservation = ctx.subagentNames.reserve(creatorAgent, 'facts')
    const leaf = await start(creatorAgent)
    ctx.subagentNames.bind(creatorAgent, leaf.childId, reservation.name)
    reservation.dispose()
    expect(ctx.subagentNames.nameOf(creatorAgent)).toBe('lead/reviewer')
    expect(ctx.sessionProjections.snapshot(creatorAgent.session).values.subagentNames).toEqual([])
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toEqual([
      { childId: creator.childId, name: 'lead/reviewer' },
      { childId: leaf.childId, name: 'lead/reviewer/facts' },
    ])
    await creator.dispose()
    expect(ctx.agents.get(creator.childId)).toBeUndefined()
    expect(ctx.subagentNames.nameOf(parent, leaf.childId)).toBe('lead/reviewer/facts')
    await parentHandle.dispose()
    const restored = await ctx.agents.resume({ resumeSessionId: parent.id })
    expect(ctx.subagentNames.resolveName(restored.agent, 'lead/reviewer/facts')).toBe(leaf.childId)
    expect(ctx.get('sessionQuery')).toBeUndefined()
  })

  it('uses a stable id prefix for children whose parent has no name', async () => {
    const { ctx, parent, start } = await setup(['hang'])
    const creator = await start()
    const creatorAgent = ctx.agents.get(creator.childId)!
    expect(ctx.subagentNames.nameOf(creatorAgent)).toBe(creator.childId)
    const reservation = ctx.subagentNames.reserve(creatorAgent, 'facts')
    expect(reservation.name).toBe(`lead/legacy:${creator.childId}/facts`)
    const childId = SessionId('accepted-leaf')
    ctx.subagentNames.bind(creatorAgent, childId, reservation.name)
    reservation.dispose()
    ctx.subagentNames.bind(parent, creator.childId, 'lead/reviewer')
    expect(ctx.subagentNames.nameOf(parent, childId)).toBe(`lead/legacy:${creator.childId}/facts`)
  })

  it('does not stop an accepted child when the alias append fails', async () => {
    const { ctx, parent, start } = await setup(['hang'])
    const reservation = ctx.subagentNames.reserve(parent, 'reviewer')
    const child = await start()
    const failure = new Error('binding append failed')
    const append = vi.spyOn(parent.session, 'append').mockImplementationOnce(() => { throw failure })
    expect(() => { ctx.subagentNames.bind(parent, child.childId, reservation.name) }).toThrow(failure)
    append.mockRestore()
    reservation.dispose()
    expect(ctx.agents.get(child.childId)).toBeDefined()
    expect(ctx.subagentNames.nameOf(parent, child.childId)).toBe(child.childId)
    const retry = ctx.subagentNames.reserve(parent, 'reviewer')
    retry.dispose()
    await child.dispose()
  })

  it('resolves message attribution automatically and unregisters it with the naming provider', async () => {
    const { ctx, parent, namesFiber, start } = await setup(['hang'])
    const child = await start()
    const sender = ctx.agents.get(child.childId)!
    ctx.subagentNames.bind(parent, child.childId, 'lead/reviewer')
    const steer = vi.spyOn(parent, 'steer')
    const send = () => ctx.subagents.sendMessage(sender, parent.id, [{ type: 'text', text: 'finding' }], {
      signal: new AbortController().signal,
    })

    await send()
    expect(steer.mock.lastCall?.[0]).toMatchObject({
      content: [{ type: 'text', text: 'Agent lead/reviewer sent a message: ' }, { type: 'text', text: 'finding' }],
      source: { kind: 'agent-message', senderSessionId: child.childId },
    })
    await namesFiber.dispose()
    await send()
    expect(steer.mock.lastCall?.[0].content[0]).toEqual({ type: 'text', text: `Agent ${child.childId} sent a message: ` })
    await ctx.plugin(SubagentNames)
    await send()
    expect(steer.mock.lastCall?.[0].content[0]).toEqual({ type: 'text', text: 'Agent lead/reviewer sent a message: ' })
    await child.dispose()
  })

  it('unregisters its projection and leaves accepted execution with its owner', async () => {
    const { ctx, parent, namesFiber, start } = await setup(['hang'])
    const names = ctx.subagentNames
    const reservation = names.reserve(parent, 'reviewer')
    const child = await start()
    await namesFiber.dispose()
    expect(ctx.get('subagentNames')).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toBeUndefined()
    expect(ctx.agents.get(child.childId)).toBeDefined()
    // Accepted callers retain their projection handle while completing a binding.
    names.bind(parent, child.childId, reservation.name)
    reservation.dispose()
    await ctx.plugin(SubagentNames)
    expect(ctx.subagentNames.nameOf(parent, child.childId)).toBe('lead/reviewer')
    await child.dispose()
  })
})
