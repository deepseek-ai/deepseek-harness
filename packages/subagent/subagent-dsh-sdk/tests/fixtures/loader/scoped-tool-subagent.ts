/** Mount the SDK delegation tool in each fixture Agent's scope. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import type { Config } from '@deepseek-ai/dsh-tool-subagent'

export const name = 'scoped-tool-subagent'
export const inject = ['agents', 'subagentModelSelection']

/**
 * Install the configured delegation tool before a published Agent starts its loop.
 * @param ctx - fixture Host context carrying Agent lifecycle events.
 * @param config - delegation-tool configuration forwarded into each Agent scope.
 */
export function apply(ctx: Context, config: Config): void {
  const install = (agent: Agent): void => {
    agent.ctx.inject(ToolSubagent.inject, (runtimeCtx) => {
      ToolSubagent.apply(runtimeCtx, {
        provider: config.provider,
        modelSelectionSettings: true,
        ...(config.toolName === undefined ? {} : { toolName: config.toolName }),
        ...(config.enableRunInBackground === undefined
          ? {}
          : { enableRunInBackground: config.enableRunInBackground }),
        ...(config.backgroundMode === undefined ? {} : { backgroundMode: config.backgroundMode }),
        ...(config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
        ...(config.persona === undefined ? {} : { persona: config.persona }),
        ...(config.toolFilter === undefined ? {} : { toolFilter: config.toolFilter }),
        ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
      }, agent.session)
    })
  }
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  for (const agent of ctx.agents.list()) install(agent)
}
