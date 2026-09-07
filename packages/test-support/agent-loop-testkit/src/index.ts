/**
 * Shared service mounting, real AgentLoop drivers, and structural Inbox stubs
 * for agent-loop tests. Callers retain ownership of their contexts, adapters,
 * optional plugins, agents, and teardown.
 * @module @deepseek-ai/dsh-agent-loop-testkit
 */

import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config as ToolRuntimeConfig } from '@deepseek-ai/dsh-tools'

export { createInboxStub, unsupportedInbox } from './inbox.ts'

interface DriverInbox extends Inbox {
  claim(target: InboxTarget, turn: number): UserMessage[]
}

/** Test driver for production Agents created by a mounted AgentLoop. */
export interface AgentLoopTestHarness {
  /**
   * Create a production Agent and fresh Session owned by the harness context.
   * @param id - shared Agent and Session identity.
   * @param options - concrete loop options.
   * @param meta - optional fresh-session workspace metadata.
   * @returns the published production Agent after creation completes.
   */
  create(id: SessionId, options?: AgentOptions, meta?: Pick<SessionHeader, 'cwd'>): Promise<Agent>
  /**
   * Admit pending messages through the production loop driver's claim operation.
   * @param agent - Agent returned by this harness's `create` method.
   * @param target - boundary whose pending input is admitted.
   * @param turn - turn that owns the admitted messages.
   * @returns next-step messages followed by one next-turn message when requested.
   */
  claim(agent: Agent, target: InboxTarget, turn: number): UserMessage[]
}

/** Configuration forwarded to the prerequisite service plugins. */
export interface AgentLoopTestDependenciesOptions {
  /** Configuration for the system-prompt registry. */
  readonly systemPrompt?: SystemPromptConfig
  /** Configuration for the tool registry. */
  readonly tools?: ToolRuntimeConfig
}

/**
 * Mount the standard prerequisite services for an AgentLoop test.
 *
 * The function deliberately does not mount AgentLoop or register an adapter,
 * so tests retain control of load order and the topology under test. The
 * context owns every mounted service and remains responsible for disposal. A
 * plugin-load failure rejects the promise; services activated earlier in the
 * sequence remain context-owned and unwind with that context.
 * @param ctx - test context that owns the mounted services.
 * @param options - optional service configuration forwarded without mutation.
 * @returns after every prerequisite service has activated.
 */
export async function mountAgentLoopTestDependencies(
  ctx: Context,
  options: AgentLoopTestDependenciesOptions = {},
): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, options.systemPrompt ?? {})
  await ctx.plugin(ToolRuntime, options.tools ?? {})
  await ctx.plugin(AgentRegistry)
}

/**
 * Mount the production AgentLoop and expose its narrow test-driver operations.
 * Mount {@link mountAgentLoopTestDependencies} and any load-order-sensitive
 * consumers before calling this helper. The context owns the loop and every
 * Agent returned by the harness.
 * @param ctx - test context with the AgentLoop prerequisite services active.
 * @returns a driver that creates production Agents and claims their real Inbox.
 */
export async function mountAgentLoopTestHarness(ctx: Context): Promise<AgentLoopTestHarness> {
  await ctx.plugin(AgentLoop, { agents: [] })
  return {
    create: async (id, options = {}, meta = {}) => ctx.agentLoop.create(id, options, meta),
    claim: (agent, target, turn) => (agent.inbox as DriverInbox).claim(target, turn),
  }
}
