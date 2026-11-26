import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { buildForkSeed, interruptedTurnClosers, Session, SessionLogOffset, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness(adapter = new MockAdapter([textResponse('done')])) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('settlement'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

describe('inbox settlement over the loop', () => {
  it('keeps a claim recoverable when Stop interrupts pre-step', async () => {
    const { ctx, agent } = await harness()
    const claimed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    ctx.on('agent/pre-step', async (_event, next) => {
      claimed.resolve(undefined)
      await release.promise
      return next()
    })

    const stopped = message('stopped')
    agent.followup(stopped)
    await claimed.promise
    expect(agent.inbox.nextTurn).toEqual([])
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    release.resolve(undefined)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([stopped])
  })

  it('discards the claim when Stop clears the queue during pre-step', async () => {
    const { ctx, agent } = await harness()
    const claimed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    ctx.on('agent/pre-step', async (_event, next) => {
      claimed.resolve(undefined)
      await release.promise
      return next()
    })

    agent.followup(message('stopped'))
    agent.followup(message('queued behind'))
    await claimed.promise
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([])
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)).toHaveLength(2)
  })

  it('forks a crashed parent without restoring the claim its interrupted turn left', async () => {
    const { ctx } = await harness()
    const claimed = message('claimed by the parent')
    const queued = message('still queued in the parent')
    const parent = Session.create(brandString<SessionId>('fork-parent'))
    parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [claimed, queued] })
    parent.append('turn/start', { turn: 1 })
    parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    // A cold read of the stored parent closes its open turn as interrupted inside the inherited prefix.
    const stored = parent.snapshotEvents()
    const repaired = [...stored, ...interruptedTurnClosers(stored)]
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: brandString<SessionId>('fork-child'),
      seed: buildForkSeed(repaired, SessionSeq(repaired.length - 1)),
      inheritedEventCount: SessionLogOffset(repaired.length),
      meta: { isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    onTestFinished(() => handle.dispose())
    expect(handle.agent.inbox.nextTurn).toEqual([queued])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(2)
  })

  it('creates a fresh Agent without recording an inbox return', async () => {
    const { agent } = await harness()
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced')).toBe(false)
  })

  it('returns the entire claim without another wake when pre-step throws after filtering', async () => {
    const { ctx, agent } = await harness()
    const omitted = message('omitted')
    const kept = message('kept')
    agent.inject(omitted)
    ctx.on('agent/pre-step', ({ messages }) => {
      messages.splice(0, 1)
      throw new Error('pre-step failed')
    })

    agent.followup(kept)
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.some(event => event.type === 'step/start')).toBe(false)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(agent.inbox.nextTurn).toEqual([omitted, kept])
  })

  it('settles the claim at step start even if request preparation fails', async () => {
    const { ctx, agent } = await harness()
    ctx.on('agent/request', () => { throw new LlmError('route refused', 'AUTH') })
    agent.followup(message('claimed'))
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    expect(events.find(event => event.type === 'step/start')?.data).toEqual({ turn: 1, step: 1 })
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(agent.inbox.nextTurn).toEqual([])
  })

  it('returns a prompt on every failure so it runs once the cause is fixed', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second'), textResponse('third')])
    const { ctx, agent } = await harness(adapter)
    let broken = true
    ctx.on('agent/pre-step', (_event, next) => {
      if (broken) throw new Error('environment broken')
      return next()
    })
    const stuck = message('stuck')
    const queued = message('while broken')
    const last = message('after fix')
    agent.followup(stuck)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([stuck])

    agent.followup(queued)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([stuck, queued])

    broken = false
    agent.followup(last)
    await agent.whenIdle()
    const admitted = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data.id] : [])
    expect(admitted).toEqual([stuck.id, queued.id, last.id])
    expect(agent.inbox.nextTurn).toEqual([])
  })

  it('reports a refused return and still closes the turn with the original failure', async () => {
    const { ctx, agent } = await harness()
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    ctx.on('agent/pre-step', () => { throw new Error('pre-step failed') })
    const original = agent.session.append.bind(agent.session)
    let armed = false
    vi.spyOn(agent.session, 'append').mockImplementation((type, ...rest) => {
      if (armed && type === 'agent/inbox/spliced' && (rest[0] as { inserted: unknown[] }).inserted.length > 0) {
        throw new Error('append unavailable')
      }
      return (original as (...args: unknown[]) => never)(type, ...rest)
    })

    const unreturnable = message('unreturnable')
    agent.followup(unreturnable)
    armed = true
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([])
    expect(errors).toEqual([expect.objectContaining({ message: 'append unavailable' })])
    const ending = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(ending?.data.reason.kind).toBe('error')
    expect(JSON.stringify(ending?.data.reason)).toContain('pre-step failed')
  })
})
