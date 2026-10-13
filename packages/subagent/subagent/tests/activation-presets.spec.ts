/**
 * Composition inheritance: a child runs on the preset its parent runs on.
 *
 * With every model-facing row on the agent plane, the tool registry's global
 * layer is empty, so a child that joins no preset reaches the model with no
 * tools at all. These assert the model-visible result — the schemas in the
 * child's own request — rather than the join that produces it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { mountLocalActivations, startPreparedActivation } from './local-activation.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'activation-presets')

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** A host composition carrying no model-facing rows, plus the preset roster. */
async function setupPresetHost(
  script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('parent idle'), textResponse('child done')],
): Promise<{ ctx: Context; adapter: MockAdapter; parent: Agent; unregister: Map<string, () => Promise<void>> }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'coding' })
  const unregister = new Map<string, () => Promise<void>>()
  for (const [id, tool] of [['coding', 'preset_only'], ['reviewing', 'reviewing_only']] as const) {
    unregister.set(id, await ctx.agentPresets.register({ id, plugins: [{ name: pathToFileURL(join(FIXTURES, 'plugins/preset-tool.js')).href, config: { tool } }] }))
  }
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'coding'),
  })
  return { ctx, adapter, parent: handle.agent, unregister }
}

/** Task and caller cancellation used to create a fresh local activation. */
function spawnRequest(parent: Agent) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
  }
}

describe('a child agent composed in-process', () => {
  it('reaches the model with its parent\'s preset tools', async () => {
    const { adapter, parent } = await setupPresetHost()

    const run = await startPreparedActivation(spawnRequest(parent), {})
    await run.result

    const childRequest = adapter.requests.at(-1)
    expect(childRequest?.tools?.map(tool => tool.name)).toEqual(['preset_only'])
    await run.dispose()
  })

  it('carries its parent\'s prompt sections', async () => {
    const { parent } = await setupPresetHost()

    const run = await startPreparedActivation(spawnRequest(parent), {})
    await run.result

    expect(run.localAgent?.session.snapshotEvents().some(event =>
      event.type === 'system/message'
      && JSON.stringify(event.data.message.content).includes('section for preset_only'))).toBe(true)
    await run.dispose()
  })

  it('records the composition it ran under on the child header', async () => {
    const { parent } = await setupPresetHost()

    const run = await startPreparedActivation(spawnRequest(parent), {})
    await run.result

    // Without this the child's own history reads back under the deployment
    // default, which is a different tool set than the one it actually used.
    expect(run.localAgent?.session.header.agentPreset).toBe('coding')
    await run.dispose()
  })

  it('follows a parent that switched preset while blank', async () => {
    const { ctx, adapter, parent } = await setupPresetHost()
    // A DIFFERENT preset, so the assertion below distinguishes reading the
    // parent's live scope chain from reading its creation header — re-linking
    // to the same id would pass either way.
    await ctx.agentPresets.recompose(parent.ctx, 'reviewing')

    const run = await startPreparedActivation(spawnRequest(parent), {})
    await run.result

    expect((adapter.requests.at(-1)?.tools ?? []).map(tool => tool.name)).toEqual(['reviewing_only'])
    expect(run.localAgent?.session.header.agentPreset).toBe('reviewing')
    await run.dispose()
  })

  it('registers runtime result tools alongside an independently selected preset', async () => {
    const { adapter, parent } = await setupPresetHost([
      toolCallResponse('submit-result', 'structured_output', { answer: 42 }),
    ])
    const run = await startPreparedActivation({
      ...spawnRequest(parent),
      agentPreset: 'reviewing',
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'number' } },
        required: ['answer'],
        additionalProperties: false,
      },
    })
    try {
      expect((await run.result).structured).toEqual({ answer: 42 })
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['reviewing_only', 'structured_output'])
    } finally {
      await run.dispose()
    }
  })

  it('uses the current generation for an explicit same-id selection while omission shares the parent', async () => {
    const { ctx, adapter, parent, unregister } = await setupPresetHost()
    await unregister.get('coding')!()
    await ctx.agentPresets.register({
      id: 'coding',
      plugins: [{ name: pathToFileURL(join(FIXTURES, 'plugins/preset-tool.js')).href, config: { tool: 'new_preset_only' } }],
    })
    const selected = await startPreparedActivation({ ...spawnRequest(parent), agentPreset: 'coding' })
    await selected.result
    const inherited = await startPreparedActivation(spawnRequest(parent))
    await inherited.result
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name)))
      .toEqual([['new_preset_only'], ['preset_only']])
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toEqual(['preset_only'])
    await selected.dispose()
    await inherited.dispose()
  })
})
