/** Exercise Session mode selection through assembled headless and SDK profiles. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-team'

/** Runtime dependencies of the keyless mode fixture. */
export const inject = ['commands', 'agentTeams']

/**
 * Record root mode commands before continuing ordinary subagent work.
 * @param ctx - assembled profile context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    if (ctx.agentTeams.isEnabled(agent)) throw new Error('new Session must default to Team off')
    for (const mode of ['on', 'off']) {
      await ctx.commands.execute(agent, `/team ${mode}`, [], new AbortController().signal)
    }
  })
}
