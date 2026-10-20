/** Exercise Session mode commands through assembled headless and SDK profiles. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '../src/index.ts'

/** Runtime dependencies of the keyless mode fixture. */
export const inject = ['commands', 'agentTeams']

/**
 * Enable the root before its first request and disable it before its second.
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
      await ctx.commands.execute(agent, '/team off', [], new AbortController().signal)
    }
    return next()
  })
}
