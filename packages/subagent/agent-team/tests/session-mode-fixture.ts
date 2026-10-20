/** Exercise Session mode selection through assembled headless and SDK profiles. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { TeamError } from '@deepseek-ai/dsh-agent-team'

/** Runtime dependencies of the keyless mode fixture. */
export const inject = ['commands', 'agentTeams']

/**
 * Enable the root before its first request, then disable it ahead of queued task work.
 * @param ctx - assembled profile context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    if (ctx.agentTeams.isEnabled(agent)) throw new Error('new Session must default to Team off')
    await ctx.commands.execute(agent, '/team on', [], new AbortController().signal)
  })
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    if (agent.session.header.parentSession === undefined && step === 2) {
      const queued = ctx.agentTeams.createTask(agent, { subject: 'queued', description: 'must not start after Team is disabled' })
      const rejected = queued.then(() => {
        throw new Error('queued task started after Team was disabled')
      }, (error: unknown) => {
        if (!(error instanceof TeamError) || error.code !== 'TEAM_DISABLED') throw error
      })
      await Promise.all([ctx.agentTeams.setEnabled(agent, false), rejected])
    }
    return next()
  })
}
