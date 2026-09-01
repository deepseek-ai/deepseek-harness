import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as fork from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

function start(ctx: Context, provider: string, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return ctx.subagents.start(provider, { signal: request.signal ?? new AbortController().signal, ...request })
}

/**
 * The two in-process backends coexist on one context: the SAME parent agent
 * delegates to a `spawn` child (fresh) and a `fork` child (seeded with its log),
 * and keeps working itself. This is the multi-provider coexistence the seam
 * exists for — the named registry lets one runtime hold both transports.
 */
async function setup(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(fork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('multi-subagent coexistence (spawn + fork on one context)', () => {
  it('both providers register and coexist', async () => {
    const { ctx } = await setup([])
    expect(ctx.subagents.list().sort()).toEqual(['fork', 'spawn'])
  })

  it('the same parent drives a spawn child AND a fork child, then keeps working', async () => {
    // Script order: parent turn 1, spawn child, fork child, parent turn 2.
    const { ctx, parent } = await setup([
      textResponse('parent turn one'),
      textResponse('spawn child reply'),
      textResponse('fork child reply'),
      textResponse('parent turn two'),
    ])

    // Parent does one real turn first, so the fork has a completed turn to seed.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent q1' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentPrefixLen = parent.session.snapshotEvents().length

    // Delegate to a fresh spawn child.
    const spawnRun = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'spawn task' }], parent })
    const spawnResult = await spawnRun.result
    expect(spawnResult.stopReason).toBe('completed')
    expect(text(spawnResult.output)).toBe('spawn child reply')

    // Delegate to a fork child (seeded with the parent's turn-1 prefix).
    const forkRun = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'fork task' }], parent })
    const forkResult = await forkRun.result
    expect(forkResult.stopReason).toBe('completed')
    expect(text(forkResult.output)).toBe('fork child reply')

    // The two children are distinct sessions, both lineage-stamped to the parent.
    const spawnChild = ctx.agents.get(spawnRun.id)!
    const forkChild = ctx.agents.get(forkRun.id)!
    expect(spawnChild.session.header.id).not.toBe(forkChild.session.header.id)
    expect(spawnChild.session.header.parentSession).toBe(parent.session.header.id)
    expect(forkChild.session.header.parentSession).toBe(parent.session.header.id)
    // The fork child inherited the parent's prefix; the spawn child did not.
    expect(forkChild.session.snapshotEvents().slice(0, parentPrefixLen).some(e => e.type === 'user/message')).toBe(true)

    await spawnRun.dispose()
    await forkRun.dispose()

    // The parent is unaffected and keeps working after both delegations.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent q2' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const lastParentMessage = parent.session.snapshotEvents().findLast(e => e.type === 'assistant/message')
    expect(lastParentMessage?.type === 'assistant/message' && text(lastParentMessage.data.message.content)).toBe('parent turn two')
    // The parent's OWN log never recorded the children's internal steps — its
    // only subagent-related entries would be tool/call+tool/result IF it had
    // used the tool, but here we called the service directly, so the parent log
    // is purely its own two turns.
    expect(parent.session.snapshotEvents().filter(e => e.type === 'turn/end')).toHaveLength(2)
  })
})
