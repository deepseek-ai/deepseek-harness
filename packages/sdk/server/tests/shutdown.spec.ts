import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
/** SDK shutdown releases managed descendants before their root Agents leave the registry. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES, type SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 6 }, () => textResponse('answer'))))
  ctx.subagents.registerProvider({
    name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  const server = new HarnessSdkJsonRpcServer(ctx, {
    request: () => Promise.reject(new Error('the server must not request the client')),
    notify: () => {},
  })
  await server.initialize({ cwd: process.cwd(), provider: 'mock', model: 'mock' })
  return { ctx, server }
}

describe('SDK descendant shutdown', () => {
  it.each([1, 2])('releases parked descendants at depth %s and preserves an unrelated tree', async (depth) => {
    const { ctx, server } = await setup()
    const receipts: SubagentActivation[] = []
    const gates = new Map<SessionId, {
      entered: PromiseWithResolvers<undefined>
      release: PromiseWithResolvers<undefined>
    }>()
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const gate = gates.get(agent.id)
      if (gate !== undefined) {
        gate.entered.resolve(undefined)
        await gate.release.promise
      }
      return next()
    })
    const start = async (parent: Agent, id: SessionId): Promise<Agent> => {
      const gate = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
      gates.set(id, gate)
      const receipt = await ctx.subagents.startActivation({
        provider: 'local-test', childId: id, label: 'parked child', delivery: 'caller', signal: new AbortController().signal,
        request: { parent, prompt: [{ type: 'text', text: 'work' }] },
      })
      receipts.push(receipt)
      await gate.entered.promise
      return ctx.agents.get(receipt.childId)!
    }
    const park = async (parent: Agent, child: Agent): Promise<void> => {
      await ctx.subagents.sendMessage(parent, child.id, [{ type: 'text', text: 'parked correction' }], {
        signal: new AbortController().signal,
      })
      ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
      gates.get(child.id)!.release.resolve(undefined)
      await child.whenIdle()
      expect(child.inbox.nextStep.length + child.inbox.nextTurn.length).toBeGreaterThan(0)
    }
    try {
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'root task' }] })
      const root = ctx.agents.get(SessionId('main'))!
      await root.whenIdle()
      const owned: Agent[] = []
      let parent = root
      for (let level = 0; level < depth; level++) {
        const child = await start(parent, SessionId(`owned-child-${level}`))
        owned.push(child)
        if (level + 1 === depth) await park(parent, child)
        else parent = child
      }
      for (const child of owned) gates.get(child.id)!.release.resolve(undefined)
      await Promise.all(owned.map(child => child.whenIdle()))
      const { agent: outside } = await ctx.agents.create({
        sessionId: SessionId('outside'), agentOptions: { provider: 'mock', model: 'mock' },
      })
      const outsideChild = await start(outside, SessionId('outside-child'))
      await park(outside, outsideChild)
      const disposed: SessionId[] = []
      ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id) })

      await expect(server.shutdown()).resolves.toEqual({})

      expect(ctx.agents.get(root.id)).toBeUndefined()
      for (const child of owned) expect(ctx.agents.get(child.id)?.id).toBeUndefined()
      expect(disposed).toEqual([...owned.toReversed().map(child => child.id), root.id])
      expect(ctx.agents.get(outside.id)).toBe(outside)
      expect(ctx.agents.get(outsideChild.id)).toBe(outsideChild)
      expect(outsideChild.inbox.nextStep.length + outsideChild.inbox.nextTurn.length).toBeGreaterThan(0)
    } finally {
      for (const gate of gates.values()) gate.release.resolve(undefined)
      await Promise.all(receipts.map(receipt => receipt.dispose()))
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('disposes roots after descendant drain fails (root failure=%s)', async (rootFails) => {
    const { ctx, server } = await setup()
    const drainFailure = new Error('descendant drain failed')
    const rootFailure = new Error('root teardown failed')
    const create = ctx.agents.create.bind(ctx.agents)
    vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      return {
        agent: handle.agent,
        dispose: async () => {
          await handle.dispose()
          if (rootFails) throw rootFailure
        },
      }
    })
    const drain = vi.spyOn(ctx.subagents, 'drainDescendants').mockRejectedValue(drainFailure)
    try {
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'root task' }] })
      const root = ctx.agents.get(SessionId('main'))!
      await root.whenIdle()
      const shutdown = server.shutdown()
      if (rootFails) {
        await expect(shutdown).rejects.toMatchObject({
          message: 'SDK server teardown failed', errors: [drainFailure, rootFailure],
        })
      } else {
        await expect(shutdown).rejects.toBe(drainFailure)
      }
      expect(drain).toHaveBeenCalledWith([root])
      expect(ctx.agents.get(root.id)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
