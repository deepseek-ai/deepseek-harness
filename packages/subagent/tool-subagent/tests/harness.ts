import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'

/** Shared non-aborted tool signal for package-local integration tests. */
export const testToolSignal = new AbortController().signal

/** Build the minimal parent Agent owned by the package-local scripted provider. */
export function fakeAgent(id = 'parent-1'): Agent {
  const sessionId = SessionId(id)
  return { id: sessionId, options: {}, session: Session.create(sessionId) } as unknown as Agent
}

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
  const ctx = new Context()
  const { withModelSelection, parentAgentOptions, ...config } = toolConfig
  if (withModelSelection === true) {
    await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: true,
      allowedModels: TEST_ALLOWED_MODELS,
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const provider = await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
    setupProviders.set(ctx, provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId(`model-selection-setup-${++setupAgentCounter}`),
      ...parentAgentOptions !== undefined ? { agentOptions: parentAgentOptions } : {},
      setup: async (agentCtx) => {
        await agentCtx.plugin(tool, { ...config, modelSelectionSettings: true })
      },
    })
    setupAgents.set(ctx, handle.agent)
    return ctx
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  const provider = await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
  setupProviders.set(ctx, provider)
  await ctx.plugin(tool, config)
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
export function callSubagent(
  ctx: Context,
  args: unknown,
  over: { agent?: Agent | undefined; signal?: AbortSignal } = {},
) {
  // Distinguish "no override" (use a default agent) from an explicit
  // `{ agent: undefined }` (test the no-agent path). Under
  // exactOptionalPropertyTypes the key is omitted rather than set to undefined.
  const agent = 'agent' in over ? over.agent : setupAgents.get(ctx) ?? fakeAgent()
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
export function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
