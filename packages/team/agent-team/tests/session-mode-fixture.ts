/** Exercise Session mode selection through assembled headless and SDK profiles. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-team'

/** Runtime dependencies of the keyless mode fixture. */
export const inject = ['agentTeams', 'tools']

/**
 * Exercise saved mode changes before and between model steps.
 * @param ctx - assembled profile context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    if (ctx.agentTeams.isEnabled(agent)) throw new Error('new Session must default to Team off')
    agent.ctx.tools.restrict({ allow: [
      'list_agents', 'send_message', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
    ] })
    for (const enabled of [true, false]) {
      await ctx.agentTeams.setEnabled(agent, enabled)
    }
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.agent !== undefined && (exec.name === 'list_agents' || exec.name === 'send_message')) {
      await ctx.agentTeams.setEnabled(exec.agent, exec.name === 'list_agents')
    }
    return result
  })
}
