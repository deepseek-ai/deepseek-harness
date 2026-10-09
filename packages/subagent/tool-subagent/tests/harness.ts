import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

/** Register a test context for awaited teardown. */
export function ownContext(ctx: Context): Context {
  contexts.add(ctx)
  return ctx
}

/** Shared non-aborted tool signal for package-local integration tests. */
export const testToolSignal = new AbortController().signal

/** Mount the real tool and service stack around one scripted subagent provider. */
const setupAgents = new WeakMap<Context, Agent>()
const setupProviders = new WeakMap<Context, Awaited<ReturnType<typeof mock.mountScriptedProvider>>>()
let setupAgentCounter = 0

/** Test-only opt-in translated to the real Host setting and Session path. */
type SetupConfig = tool.Config & {
  withModelSelection?: boolean
  parentAgentOptions?: AgentOptions
}

const TEST_ALLOWED_MODELS = [
  'allowed-model', 'child-model', 'configured-model', 'current-model', 'fast-model',
  'other-model', 'parent-model', 'selected-model', 'unlisted-model',
].flatMap(model => [
  { provider: 'alpha', model },
  { provider: 'current-provider', model },
  { provider: 'missing', model },
])

export async function setup(toolConfig: SetupConfig, mockConfig: Partial<mock.Config> = {}): Promise<Context> {
  const ctx = ownContext(new Context())
  const { withModelSelection, parentAgentOptions, ...config } = toolConfig
  if (withModelSelection === true) {
    await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: true,
      allowedModels: TEST_ALLOWED_MODELS,
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const provider = await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
    setupProviders.set(ctx, provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId(`model-selection-setup-${++setupAgentCounter}`),
      ...parentAgentOptions !== undefined ? { agentOptions: parentAgentOptions } : {},
      setup: async (agentCtx, agent) => {
        const fiber = agentCtx.inject(tool.inject, (runtimeCtx) => {
          tool.apply(runtimeCtx, { ...config, modelSelectionSettings: true }, agent.session)
        })
        await fiber.await()
      },
    })
    setupAgents.set(ctx, handle.agent)
    return ctx
  }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const provider = await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
  setupProviders.set(ctx, provider)
  await ctx.plugin(tool, config)
  const handle = await ctx.agents.create({ sessionId: SessionId(`tool-setup-${++setupAgentCounter}`) })
  setupAgents.set(ctx, handle.agent)
  return ctx
}

/** Dispose the scripted provider mounted by {@link setup}. */
export async function disposeSetupProvider(ctx: Context): Promise<void> {
  const provider = setupProviders.get(ctx)
  if (provider === undefined) throw new Error('context has no setup provider')
  setupProviders.delete(ctx)
  await provider.dispose()
}

/** Return the real Agent created for a settings-controlled setup. */
export function modelSelectionSetupAgent(ctx: Context): Agent {
  const agent = setupAgents.get(ctx)
  if (agent === undefined) throw new Error('context has no model-selection setup Agent')
  return agent
}

let callCounter = 0

/** Execute the registered subagent tool through the real ToolRuntime pipeline. */
export async function callSubagent(
  ctx: Context,
  args: unknown,
  over: { agent?: Agent | undefined; signal?: AbortSignal } = {},
) {
  // Distinguish "no override" (use a default agent) from an explicit
  // `{ agent: undefined }` (test the no-agent path). Under
  // exactOptionalPropertyTypes the key is omitted rather than set to undefined.
  const agent = 'agent' in over ? over.agent : setupAgents.get(ctx)
    ?? (await ctx.agents.create({ sessionId: SessionId(`tool-call-parent-${++setupAgentCounter}`) })).agent
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'subagent',
    arguments: args,
    ...agent ? { agent } : {},
    ...over.signal ? { signal: over.signal } : {},
  })
}

/** Join text blocks from one rendered tool result. */
export function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
