/** Per-session roster generations: the caller-visible job set, replaced whole after every lifecycle change. */

import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobListFrame, JobListRequest } from './types.ts'
import { OutputWaiter, sleep } from './wake.ts'

/** Cadence bound for one roster generation. */
export interface RowsOptions {
  /** Coalescing window after a lifecycle event before the next rows read, in milliseconds. */
  readonly flushMs: number
}

/**
 * Stream the jobs one session can see: one frame on open, then one after
 * every lifecycle commit that touches a visible job (registration, progress,
 * stopping, settlement, removal), coalesced over `flushMs`. Output appends
 * never refresh the roster — a settled projection already carries the final
 * byte count — so the stream is quiet while a job merely writes. Reads are
 * projections; the model's cursor and notice state never observe them.
 * @param registry - the live job registry.
 * @param request - the session whose visible set to mirror.
 * @param options - the coalescing window.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the roster frame sequence for one generation.
 */
export async function* streamJobRows(
  registry: JobRegistry,
  request: JobListRequest,
  options: RowsOptions,
  signal: AbortSignal,
): AsyncIterable<JobListFrame> {
  signal.throwIfAborted()
  const waiter = new OutputWaiter()
  // Subscribe before the first read so a commit between the read and the
  // wait cannot be missed.
  const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
    if (event.type === 'output') return
    const owner = event.job.owner
    if (owner === undefined || owner === request.sessionId) waiter.wake()
  })
  try {
    yield { type: 'rows', jobs: registry.list(request.sessionId) }
    while (true) {
      await waiter.wait(signal)
      // Let a burst of commits settle into one frame.
      await sleep(options.flushMs, signal)
      if (signal.aborted) return
      yield { type: 'rows', jobs: registry.list(request.sessionId) }
    }
  } finally {
    unsubscribe()
  }
}
