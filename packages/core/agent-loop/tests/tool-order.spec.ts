import { createUserMessage } from '@deepseek-ai/dsh-llm'
/**
 * Loop-level tool-order determinism: the request/header event — and therefore the frozen
 * request the adapter receives — carries the assembly's canonical tool order (system-prompt's
 * `toolOrder` config, or lexicographic name order), regardless of the order tool plugins
 * happened to register in. Registration order is a concurrent loading artifact
 * and must not leak downstream.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt, { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import type { Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter, toolOrder?: SystemPromptConfig['toolOrder']) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: 'stable base', ...toolOrder !== undefined ? { toolOrder } : {} })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function registerNamed(ctx: Context, name: string) {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: `the ${name} tool`,
    parameters: {},
    async execute() {
      return [{ type: 'text', text: name }]
    },
  }))
}

/** Run one text-only turn and return the harness context + agent. */
async function runTurn(registrationOrder: string[], toolOrder?: SystemPromptConfig['toolOrder']) {
  const adapter = new MockAdapter([textResponse('done')])
  const ctx = await harness(adapter, toolOrder)
  for (const name of registrationOrder) registerNamed(ctx, name)
  const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return { ctx, agent, adapter }
}

describe('loop-level canonical tool order', () => {
  it('logs the request/header with tools in canonical order, not registration order', async () => {
    const { agent, adapter } = await runTurn(['zulu', 'alpha', 'mike'])
    const header = foldRequestHeader(agent.session.snapshotEvents())
    expect(header?.tools?.map(tool => tool.name)).toEqual(['alpha', 'mike', 'zulu'])
    // The dispatched request is built FROM the logged header (whose tools the
    // assembly already canonicalized) and reaches the adapter deep-frozen —
    // the marker the reconstruction invariant keys on.
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['alpha', 'mike', 'zulu'])
    expect(Object.isFrozen(adapter.requests[0])).toBe(true)
    expect(adapter.requests[0]?.sessionId).toBe(agent.session.id)
  })

  it('produces the same header order for any registration order', async () => {
    const first = await runTurn(['alpha', 'mike', 'zulu'])
    const second = await runTurn(['zulu', 'mike', 'alpha'])
    const names = (run: typeof first) => foldRequestHeader(run.agent.session.snapshotEvents())?.tools?.map(tool => tool.name)
    expect(names(first)).toEqual(['alpha', 'mike', 'zulu'])
    expect(names(second)).toEqual(names(first))
  })

  it('honors a configured toolOrder in the logged header and the dispatched request', async () => {
    const { agent, adapter } = await runTurn(['alpha', 'zulu', 'mike'], ['zulu', TOOL_ORDER_REST])
    const header = foldRequestHeader(agent.session.snapshotEvents())
    expect(header?.tools?.map(tool => tool.name)).toEqual(['zulu', 'alpha', 'mike'])
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['zulu', 'alpha', 'mike'])
    expect(Object.isFrozen(adapter.requests[0])).toBe(true)
  })

  it('closes a no-step turn when toolOrder names an unregistered tool', async () => {
    const adapter = new MockAdapter([textResponse('never sent')])
    const ctx = await harness(adapter, ['ghost', TOOL_ORDER_REST])
    registerNamed(ctx, 'alpha')
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(0)
    expect(foldRequestHeader(agent.session.snapshotEvents())).toBeUndefined()
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/start')).toBe(true)
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/end')).toBe(true)
    expect(agent.session.snapshotEvents().some(e => e.type === 'step/start')).toBe(false)
    expect(agent.session.snapshotEvents().some(e => e.type === 'step/end')).toBe(false)
  })
})
