/**
 * The `job` family of the Workspace registry's archive admission: the
 * background jobs a Session owns that have not settled, and their kill when
 * the Session is archived with its work. Installed by every registry
 * implementation through the seam's constructor, so it holds for each of
 * them through the abstract `list` and `kill` alone.
 *
 * @module @deepseek-ai/dsh-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import type { JobRegistry } from './index.ts'
import type { JobView } from './view.ts'

/**
 * Answer `workspace/session-activity` with the running or stopping jobs the
 * asked Session owns, and `workspace/session-stop` by killing each of them.
 * Both listeners live as long as `ctx`'s fiber — the registry's own.
 * @param ctx - the registry's registration context.
 * @param registry - the registry whose `list` and `kill` answer.
 */
export function installJobArchiveAdmission(ctx: Context, registry: JobRegistry): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const jobs = runningJobs(registry, sessionId)
    const rest = await next()
    if (jobs.length === 0) return rest
    const own: SessionActivity = { kind: 'job', items: jobs.map(job => ({ id: job.id, label: job.label })) }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    for (const job of runningJobs(registry, sessionId)) {
      try {
        registry.kill(job.id, sessionId, 'session archived')
      } catch (error: unknown) {
        // A producer throwing on cancel must not keep the Session's other jobs running once it is archived.
        ctx.logger.warn(`jobs: killing "${job.id}" for an archived Session failed: ${String(error)}`)
      }
    }
  })
}

/** The jobs the Session owns that have not settled; unowned jobs in the same listing belong to nobody. */
function runningJobs(registry: JobRegistry, owner: SessionId): JobView[] {
  return registry.list(owner)
    .filter(job => job.owner === owner && (job.status === 'running' || job.status === 'stopping'))
}
