/** Agent-scoped Schedule tool tests reuse the Host Schedule harness and mount the tools under a scope. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import * as ToolSchedule from '../src/index.ts'

export { agentFor, harness } from '../../schedule/tests/harness.ts'

/**
 * Mount the Schedule tools under one exact Agent scope.
 *
 * The scope key is the Agent itself, which is the same key the tool registry
 * routes a dispatch by, so the registered definitions are visible only to that
 * Agent.
 * @param ctx - Host context already carrying the `tools` and `schedule` services.
 * @param agent - Exact Agent whose dispatches may reach the tools.
 * @returns The scope owning the registrations, for disposal.
 */
export async function mountToolSchedule(ctx: Context, agent: Agent): Promise<Scope> {
  const scope = createScope(ctx, agent)
  await scope.ctx.plugin(ToolSchedule)
  return scope
}
