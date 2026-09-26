/** Package-owned background-job event-protocol invariants. @module @deepseek-ai/dsh-jobs/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { JobId } from './brand.ts'
import type { JobEvent, JobView } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-jobs'
const TERMINAL_STATUSES = new Set(['completed', 'killed', 'failed'])

/**
 * Where one announced job stands: `live` from its first event until its
 * settlement, `settled` until its removal. An id first seen through a later
 * event is adopted at that phase, so a companion mounted after the job
 * started raises nothing.
 */
type Phase = 'live' | 'settled'

/** Cordis companion plugin name. */
export const name = 'jobs-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The registry's own current projection of `id`, or undefined once the record is gone. */
function readBack(ctx: Context, id: JobId, owner: JobView['owner']): JobView | undefined {
  try {
    return ctx.jobs.get(id, owner)
  } catch {
    // The registry throws for an id outside the caller's set; after a removal that is the expected answer.
    return undefined
  }
}

/**
 * The announced projection must agree with the registry's own read: the
 * immutable identity matches, and the announced output total is not ahead of
 * the committed one.
 */
function checkAnnounced(read: JobView, announced: JobView, what: string, fail: InvariantFailure): void {
  const id = String(announced.id)
  for (const key of ['kind', 'label', 'owner', 'startedAt'] as const) {
    if (read[key] !== announced[key]) {
      fail(`${what} for job ${id} announces ${key} ${JSON.stringify(announced[key])} while the registry reads ${JSON.stringify(read[key])}`)
    }
  }
  if (announced.output.total > read.output.total) {
    fail(`${what} for job ${id} announces output total ${announced.output.total} ahead of the registry's ${read.output.total}`)
  }
}

/** Install the per-job protocol and event-versus-read checks over the whole event stream. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const phases = new Map<string, Phase>()
  ctx.jobs.events.subscribe({ owners: 'all' }, (event: JobEvent) => {
    if (event.type === 'output') {
      const id = String(event.id)
      const read = readBack(ctx, event.id, event.owner)
      if (read === undefined) fail(`output announced for job ${id} that the registry no longer returns`)
      if (event.total > read.output.total) {
        fail(`output announced for job ${id} at total ${event.total} ahead of the registry's ${read.output.total}`)
      }
      if (!phases.has(id)) phases.set(id, 'live')
      return
    }
    const { job } = event
    const id = String(job.id)
    const phase = phases.get(id)
    const terminal = TERMINAL_STATUSES.has(job.status)
    switch (event.type) {
      case 'registered':
        if (phase !== undefined) fail(`registered announced for job ${id} after earlier events for the same id`)
        if (terminal || job.finishedAt !== undefined) fail(`registered job ${id} must announce a live status without finishedAt`)
        break
      case 'progress':
      case 'stopping':
        if (phase === 'settled') fail(`${event.type} announced for job ${id} after its settlement`)
        if (terminal) fail(`${event.type} announced for job ${id} with a terminal status`)
        break
      case 'settled':
        if (phase === 'settled') fail(`settled announced twice for job ${id}`)
        if (!terminal) fail(`settled job ${id} must announce a terminal status, got ${JSON.stringify(job.status)}`)
        if (job.finishedAt === undefined || job.finishedAt < job.startedAt) {
          fail(`settled job ${id} must announce finishedAt no earlier than startedAt`)
        }
        if (job.progress !== undefined) fail(`settled job ${id} must announce a cleared progress line`)
        break
      case 'removed':
        if (phase === 'live') fail(`removed announced for job ${id} before its settlement`)
        if (readBack(ctx, job.id, job.owner) !== undefined) fail(`removed announced for job ${id} that the registry still returns`)
        phases.delete(id)
        return
      /* v8 ignore start -- defensive: the lifecycle event union is closed and exhaustive here; a new variant fails loudly */
      default: {
        const exhaustive: never = event
        fail(`unknown job event ${String(exhaustive)} for job ${id}`)
      }
      /* v8 ignore stop */
    }
    const read = readBack(ctx, job.id, job.owner)
    if (read === undefined) fail(`${event.type} announced for job ${id} that the registry does not return`)
    checkAnnounced(read, job, event.type, fail)
    if (event.type === 'settled' && (read.status !== job.status || read.finishedAt !== job.finishedAt)) {
      fail(`settled job ${id} announces ${job.status} at ${String(job.finishedAt)}`
        + ` while the registry reads ${read.status} at ${String(read.finishedAt)}`)
    }
    phases.set(id, event.type === 'settled' ? 'settled' : 'live')
  })
}, { inject: ['jobs'] })

/**
 * Register the job-registry invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
