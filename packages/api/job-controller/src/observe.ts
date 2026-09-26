/** Per-job observation generations: anchor, coalesced output, terminal status. */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobChunk, JobRegistry, JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import type { JobFollowFrame, JobFollowRequest } from './types.ts'
import { OutputWaiter, sleep } from './wake.ts'

/** Cadence and framing bounds for one observation generation. */
export interface ObserveJobOptions {
  /** Coalescing window after a wake before reading, in milliseconds. */
  readonly flushMs: number
  /**
   * Soft byte budget per `output` frame. Accumulated chunks flush once the
   * budget is met; one chunk larger than the budget ships whole (the
   * registry's retention cap is the hard bound on any single chunk).
   */
  readonly maxFrameBytes: number
}

function isTerminal(status: JobStatus): boolean {
  return status !== 'running' && status !== 'stopping'
}

/**
 * Stream one job's retained output from an absolute offset: one `opened`
 * anchor, coalesced `output` frames as the ring advances, then one terminal
 * `status` after the settled job is drained, after which the generation
 * closes normally. A removal announced mid-generation (the owner's teardown)
 * closes it with the removed job's terminal projection instead of a failed
 * read. Reads are non-consuming — the model-facing cursor and
 * notice state never observe them; reconnecting callers resume by passing
 * the last frame's `next` as `from`. The request's session is the fenced
 * read's caller: the registry rejects a job the session cannot see and an
 * unknown job.
 * @param registry - the live job registry.
 * @param request - target job, owning session, and optional resume offset.
 * @param options - cadence and framing bounds.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the observation frame sequence for one generation.
 */
export async function* observeJobOutput(
  registry: JobRegistry,
  request: JobFollowRequest,
  options: ObserveJobOptions,
  signal: AbortSignal,
): AsyncIterable<JobFollowFrame> {
  if (request.from !== undefined && (!Number.isSafeInteger(request.from) || request.from < 0)) {
    throw new Error(`invalid observe offset: expected a non-negative safe integer, got ${JSON.stringify(request.from)}`)
  }
  signal.throwIfAborted()
  // The brand is nominal typing only; the wire boundary stamps it here rather
  // than value-importing the registry package's constructor.
  const id = String(request.jobId) as JobId
  const waiter = new OutputWaiter()
  // A removal announced during the generation: the owner's teardown settled
  // and dropped the record, so the projection it announced is the last word
  // and the read after the flush window would only find an unknown id.
  let removed: JobView | undefined
  // Subscribe before the first read so an append between the anchor read and
  // the wait cannot be missed.
  const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
    const changed = event.type === 'output' ? event.id : event.job.id
    if (changed !== id) return
    if (event.type === 'removed') removed = event.job
    waiter.wake()
  })
  try {
    let job = registry.get(id, request.sessionId)
    let cursor = request.from ?? job.output.earliest
    yield { type: 'opened', job, from: cursor }
    while (!signal.aborted) {
      if (removed !== undefined) {
        yield { type: 'status', job: removed }
        return
      }
      const read = registry.readAt(id, cursor, request.sessionId)
      if (read.chunks.length > 0 || read.lossy) {
        yield* outputFrames(read.chunks, read.next, read.lossy, options.maxFrameBytes)
      }
      cursor = read.next
      job = registry.get(id, request.sessionId)
      if (isTerminal(job.status) && cursor >= job.output.total) {
        yield { type: 'status', job }
        return
      }
      await waiter.wait(signal)
      // Let a burst accumulate so producer chatter becomes bounded frames.
      await sleep(options.flushMs, signal)
    }
  } finally {
    unsubscribe()
  }
}

/** Split one read into frames along the soft per-frame byte budget. */
function* outputFrames(
  chunks: readonly JobChunk[],
  next: number,
  lossy: boolean,
  maxFrameBytes: number,
): Iterable<JobFollowFrame> {
  let batch: JobChunk[] = []
  let batchBytes = 0
  let flaggedLossy = lossy
  for (const chunk of chunks) {
    batch.push(chunk)
    batchBytes += Buffer.byteLength(chunk.text, 'utf8')
    if (batchBytes >= maxFrameBytes) {
      const last = batch[batch.length - 1]
      /* v8 ignore start -- a non-empty batch always has a last chunk; the arm only discharges noUncheckedIndexedAccess. */
      const end = last === undefined ? next : last.at + Buffer.byteLength(last.text, 'utf8')
      /* v8 ignore stop */
      yield {
        type: 'output',
        chunks: batch,
        next: end,
        ...flaggedLossy ? { lossy: true as const } : {},
      }
      flaggedLossy = false
      batch = []
      batchBytes = 0
    }
  }
  if (batch.length > 0 || flaggedLossy) {
    yield {
      type: 'output',
      chunks: batch,
      next,
      ...flaggedLossy ? { lossy: true as const } : {},
    }
  }
}
