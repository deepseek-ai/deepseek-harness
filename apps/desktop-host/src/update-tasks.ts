/** Desktop installation admission and task inspection for the shared Web Host. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-client-connection'

/**
 * Whether stopping the Host now would interrupt work: a generating or tool-running
 * agent (including subagents and turns waiting for approval), queued inbox
 * messages, or a running or stopping background job.
 * @param liveAgents - Current agent roster.
 * @param jobs - Job registry queried for the global roster and each agent's own jobs.
 * @returns true when any of those conditions holds.
 */
export function hasDesktopActiveTasks(liveAgents: ReturnType<Context['agents']['list']>, jobs: Context['jobs']): boolean {
  return liveAgents.some(agent => agent.status === 'running'
    || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
    || [undefined, ...liveAgents].some(agent => jobs.list(agent?.id)
      .some(job => job.status === 'running' || job.status === 'stopping'))
}

/**
 * Register update admission on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal removes the request listener.
 * @returns Task inspector whose lock refuses new API requests, drains admitted requests, and rechecks work.
 */
export function installDesktopUpdateTaskControl(ctx: Context): (action: 'inspect' | 'lock' | 'unlock') => Promise<boolean> {
  let locked = false
  let lockGeneration = 0
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  const pendingRequests = new Set<Promise<void>>()
  ctx.on('connection/request', async (_request, response, next) => {
    if (locked) {
      response.writeHead(503)
      response.end()
      return
    }
    const finished = Promise.withResolvers<void>()
    pendingRequests.add(finished.promise)
    try { await next() }
    finally { pendingRequests.delete(finished.promise); finished.resolve() }
  })
  return async (action) => {
    if (stopped) throw new Error('desktop update: Host is stopping')
    if (action === 'unlock') { locked = false; lockGeneration++ }
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop update: task services are unavailable')
    if (action === 'lock') {
      locked = true
      const generation = ++lockGeneration
      // Read requests are not tasks; admitted writes must finish before the final work check.
      await Promise.all(pendingRequests)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Disposal can run while admitted requests drain.
      if (stopped) throw new Error('desktop update: Host is stopping')
      if (generation !== lockGeneration) throw new Error('desktop update: admission lock was superseded')
    }
    return hasDesktopActiveTasks(agents.list(), jobs)
  }
}
