/** Quit-time inspection of interruptible work and armed scheduled reminders for the Electron shell. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-schedule'
import { hasDesktopActiveTasks } from './update-tasks.ts'

/** What quitting the Host now would affect. */
export interface DesktopQuitInspection {
  /** Work the shared update-restart check also counts: running agents, queued messages, live jobs. */
  readonly activeTasks: boolean
  /** A loaded session holds a scheduled reminder whose timer is armed in this process. */
  readonly scheduledTasks: boolean
}

/**
 * Register the quit inspector on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal makes the inspector reject.
 * @returns Inspector reporting active tasks together with armed reminders of the loaded sessions
 *   (the `schedule` family of `workspace/session-activity`); reminders in sessions that were never
 *   loaded during this run cannot fire and are not counted.
 */
export function installDesktopQuitInspection(ctx: Context): () => Promise<DesktopQuitInspection> {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  return async () => {
    if (stopped) throw new Error('desktop quit: Host is stopping')
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop quit: task services are unavailable')
    const liveAgents = agents.list()
    const activeTasks = hasDesktopActiveTasks(liveAgents, jobs)
    let scheduledTasks = false
    for (const agent of liveAgents) {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]))
      if (activity.some(entry => entry.kind === 'schedule')) { scheduledTasks = true; break }
    }
    return { activeTasks, scheduledTasks }
  }
}
