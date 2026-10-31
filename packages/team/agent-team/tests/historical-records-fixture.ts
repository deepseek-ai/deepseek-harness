/** Exercise task writes after retired Team records through the headless profile. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId, TeamMessageId } from '../src/types.ts'

/** Services used to append historical records and exercise the task board. */
export const inject = ['agentTeams']

/**
 * Append retired records before creating a task on the root board.
 * @param ctx - assembled profile context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    const teamId = TeamId(agent.id)
    const childId = SessionId('historical-worker')
    const messageId = TeamMessageId('historical-message')
    agent.session.append('team/member', { version: 2, teamId, member: {
      id: childId, name: 'old-worker', description: 'retired teammate',
      provider: 'spawn', context: 'fresh', phase: 'active',
    } })
    agent.session.append('team/message/delivered', { version: 2, teamId, messageId, targetId: childId })
    agent.session.append('team/message/queued', { version: 2, teamId, message: {
      id: messageId, senderId: agent.id, senderName: 'lead', targetId: childId,
      content: [{ type: 'text', text: 'retired mailbox content' }],
    } })
    await ctx.agentTeams.setEnabled(agent, true)
    await ctx.agentTeams.createTask(agent, { subject: 'Retained task', description: 'Task board accepts work after retired records.' })
    await ctx.agentTeams.setEnabled(agent, false)
  })
}
