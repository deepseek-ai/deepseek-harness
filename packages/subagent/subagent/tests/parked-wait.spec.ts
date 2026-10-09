import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/** Host completion races around idle local children with preserved input. */
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES, type SubagentActivation } from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { managerState } from './manager-internals.ts'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function setup() {
  const ctx = new Context()
  const releases: Array<() => void> = []
  const starts: Promise<SubagentActivation>[] = []
  const pending: Promise<unknown>[] = []
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 12 }, () => textResponse('answer'))))
  ctx.subagents.registerProvider({
    name: 'local',
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('parked-wait-root'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })

  function gate() {
    const deferred = Promise.withResolvers<undefined>()
    releases.push(() => { deferred.resolve(undefined) })
    return deferred
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise)
    return promise
  }

  function start(owner = parent, provider = 'local') {
    const started = ctx.subagents.startActivation({
      provider,
      label: 'child task',
      delivery: 'caller',
      signal: new AbortController().signal,
      request: { parent: owner, prompt: [{ type: 'text', text: 'child task' }] },
    })
    starts.push(started)
    return started
  }

  async function park() {
    const entered = Promise.withResolvers<Agent>()
    const release = gate()
    const off = ctx.on('agent/pre-step', async ({ agent }, next) => {
      entered.resolve(agent)
      await release.promise
      return next()
    })
    try {
      const activation = await start()
      const child = await entered.promise
      child.steer(message('parked correction'))
      ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
      release.resolve(undefined)
      await child.whenIdle()
      expect(child.inbox.nextStep).toHaveLength(1)
      return { activation, child }
    } finally {
      release.resolve(undefined)
      off()
    }
  }

  async function dispose() {
    for (const release of releases) release()
    const settled = await Promise.allSettled(starts)
    await Promise.all(settled.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    await Promise.allSettled(pending)
    await ctx.fiber.dispose()
  }

  return { ctx, parent, gate, track, start, park, dispose }
}

describe('completion around parked child inboxes', () => {
  it('rechecks a revived sibling after another parked child finishes maintenance', async () => {
    const harness = await setup()
    const { ctx, parent, gate, track } = harness
    try {
      const { child: first } = await harness.park()
      const { child: second } = await harness.park()
      const finishMaintenance = gate()
      const maintenance = track(second.runMaintenance(async () => { await finishMaintenance.promise }))
      let settled = false
      const waiting = track(ctx.subagents.waitForChildren(parent).then((value) => { settled = true; return value }))
      // Drain the already queued idle observations while maintenance stays gated.
      await setImmediate()

      const entered = gate()
      const releaseTurn = gate()
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (agent === first) {
          entered.resolve(undefined)
          await releaseTurn.promise
        }
        return next()
      })
      first.followup(message('wake sibling'))
      await entered.promise
      first.steer(message('unclaimed while running'))
      finishMaintenance.resolve(undefined)
      await maintenance
      await setImmediate()
      expect(first.status).toBe('running')
      expect(first.inbox.nextStep).toHaveLength(1)
      expect(settled).toBe(false)

      releaseTurn.resolve(undefined)
      await expect(waiting).resolves.toBe(true)
      expect(first.status).toBe('idle')
      expect(second.inbox.nextStep).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it.each(['publish', 'rollback'] as const)('waits for a parked owner\'s unpublished grandchild to %s', async (outcome) => {
    const harness = await setup()
    const { ctx, parent, gate, track } = harness
    try {
      const { child: owner } = await harness.park()
      const preparing = gate()
      const releasePrepare = gate()
      ctx.subagents.registerProvider({
        name: 'preparing',
        capabilities: NO_START_CAPABILITIES,
        inheritsParentContext: false,
        prepareContinuable: async () => {
          preparing.resolve(undefined)
          await releasePrepare.promise
          if (outcome === 'rollback') throw new Error('preparation rejected')
          return {}
        },
      })
      const entered = gate()
      const releaseTurn = gate()
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (agent !== owner) {
          entered.resolve(undefined)
          await releaseTurn.promise
        }
        return next()
      })
      const started = harness.start(owner, 'preparing')
      const rejected = outcome === 'rollback' ? expect(started).rejects.toThrow('preparation rejected') : undefined
      await preparing.promise
      let settled = false
      const waiting = track(ctx.subagents.waitForChildren(parent).then((value) => { settled = true; return value }))
      await setImmediate()
      expect(settled).toBe(false)
      expect(managerState(ctx).resident.size).toBe(1)
      releasePrepare.resolve(undefined)
      if (outcome === 'publish') {
        const grandchild = await started
        await entered.promise
        await setImmediate()
        expect(settled).toBe(false)
        releaseTurn.resolve(undefined)
        await expect(grandchild.result).resolves.toMatchObject({ stopReason: 'completed' })
      } else {
        await rejected
      }
      await expect(waiting).resolves.toBe(true)
      expect(owner.inbox.nextStep).toHaveLength(1)
      expect(ctx.agents.get(owner.id)).toBe(owner)
    } finally {
      await harness.dispose()
    }
  })

  it('releases a final-result wait when direct injection parks the idle child during flush', async () => {
    const harness = await setup()
    const { ctx, parent, gate, track } = harness
    try {
      const flushing = gate()
      const releaseFlush = gate()
      ctx.on('session/flush', async (session) => {
        if (session.header.parentSession !== parent.id) return
        flushing.resolve(undefined)
        await releaseFlush.promise
      })
      const started = await harness.start()
      await flushing.promise
      const child = ctx.agents.get(started.childId)!
      const activation = managerState(ctx).resident.get(started.childId)!
      const joinedResult = gate()
      const originalCatch = activation.result.promise.catch.bind(activation.result.promise)
      const catchSpy = vi.spyOn(activation.result.promise, 'catch').mockImplementation((handler) => {
        joinedResult.resolve(undefined)
        return originalCatch(handler)
      })
      let resultSettled = false
      void started.result.then(() => { resultSettled = true })
      const waiting = track(ctx.subagents.waitForChildren(parent))
      await joinedResult.promise
      child.inject(message('context for a future turn'))
      await expect(waiting).resolves.toBe(true)
      expect(resultSettled).toBe(false)
      expect(child.inbox.nextStep).toHaveLength(1)
      expect(ctx.agents.get(child.id)).toBe(child)
      catchSpy.mockRestore()
      releaseFlush.resolve(undefined)
    } finally {
      await harness.dispose()
    }
  })

  it.each(['published', 'materializing'] as const)('discovers a %s child created during an earlier idle observation', async (phase) => {
    const harness = await setup()
    const { ctx, parent, gate, track } = harness
    try {
      const { child: parked } = await harness.park()
      const finishMaintenance = gate()
      const maintenance = track(parked.runMaintenance(async () => { await finishMaintenance.promise }))
      let settled = false
      const waiting = track(ctx.subagents.waitForChildren(parent).then((value) => { settled = true; return value }))
      await setImmediate()

      const creating = gate()
      const releaseCreate = gate()
      const agents = managerState(ctx).ownerCtx.agents
      const create = agents.create.bind(agents)
      const createSpy = vi.spyOn(agents, 'create').mockImplementation(async (options) => {
        creating.resolve(undefined)
        if (phase === 'materializing') await releaseCreate.promise
        return create(options)
      })
      const entered = gate()
      const releaseTurn = gate()
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (agent !== parked) {
          entered.resolve(undefined)
          await releaseTurn.promise
        }
        return next()
      })
      const started = harness.start()
      await creating.promise
      if (phase === 'published') await entered.promise
      finishMaintenance.resolve(undefined)
      await maintenance
      await setImmediate()
      expect(settled).toBe(false)

      releaseCreate.resolve(undefined)
      const child = await started
      await entered.promise
      expect(settled).toBe(false)
      releaseTurn.resolve(undefined)
      await expect(waiting).resolves.toBe(true)
      await expect(child.result).resolves.toMatchObject({ stopReason: 'completed' })
      expect(parked.inbox.nextStep).toHaveLength(1)
      createSpy.mockRestore()
    } finally {
      await harness.dispose()
    }
  })
})
