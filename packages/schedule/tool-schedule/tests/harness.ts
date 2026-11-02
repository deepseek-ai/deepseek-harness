/** Agent-scoped Schedule tool tests reuse the Host Schedule harness and mount the tools under a scope. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import * as ToolSchedule from '../src/index.ts'

export { agentFor, boundTask, harness, seedTasks } from '../../schedule/tests/harness.ts'

/** Supply only the PTC language needed to assemble the real tool SDK. */
export class PromptRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(): never { throw new Error('Prompt assembly must not resolve a PTC program') }
  run(): never { throw new Error('Prompt assembly must not execute a PTC program') }
}

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
