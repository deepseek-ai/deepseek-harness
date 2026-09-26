/**
 * Host job Remote owner: streams the background-job roster one session can
 * see and one job's retained output to browsers over the generated `job`
 * namespace, and stops a job on a human's behalf. The streams are
 * projections of `ctx.jobs`; the model's consuming cursor and notice state
 * never observe them, and a human kill is not the model's own, so the
 * completion notice still reaches the owning agent.
 * @module @deepseek-ai/dsh-api-job-controller
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-jobs'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { observeJobOutput } from './observe.ts'
import { streamJobRows } from './rows.ts'
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host job Remote namespace owner. */
    jobController: JobController
  }
}

/** Default coalescing window between reads, in milliseconds. */
const DEFAULT_OBSERVE_FLUSH_MS = 100

/** Default soft byte budget per output frame. */
const DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024

/** Job Controller deployment policy. */
export interface Config {
  /** Coalescing window after a registry commit before the next rows or output read, in milliseconds (default 100). */
  readonly observeFlushMs?: number
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  readonly observeMaxFrameBytes?: number
}

/** Host service backing the generated `ctx.remote.job` namespace. */
export class JobController extends TypertRemoteService {
  static inject = ['jobs', 'typert']

  static Config: z<Config> = z.object({
    observeFlushMs: z.natural().min(1).default(DEFAULT_OBSERVE_FLUSH_MS),
    observeMaxFrameBytes: z.natural().min(1).default(DEFAULT_OBSERVE_MAX_FRAME_BYTES),
  })

  private readonly observeFlushMs: number
  private readonly observeMaxFrameBytes: number

  /**
   * @param ctx - Host context carrying the live Agent registry and the job registry.
   * @param config - observation cadence and framing policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jobController', { namespace: 'job' })
    // schemastery (the exported Config schema) has already filled the defaulted
    // fields; the assertion records that resolution, not a hidden fallback.
    const resolved = config as Required<Config>
    this.observeFlushMs = resolved.observeFlushMs
    this.observeMaxFrameBytes = resolved.observeMaxFrameBytes
  }

  /**
   * Stream the jobs one session can see — its own plus every unowned job —
   * as whole-set frames: one on open, then one after each coalesced burst of
   * lifecycle commits. The stream has no natural end; the carrier closes it.
   * @param request - the session whose visible set to mirror.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns the roster frames.
   */
  @Remote({ mode: 'stream' })
  list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> {
    return streamJobRows(this.ctx.jobs, request, { flushMs: this.observeFlushMs }, signal)
  }

  /**
   * Stream one job's retained output from an absolute byte offset, then its
   * terminal projection once settled and drained. Non-consuming: the
   * model-facing cursor and notice state never observe these reads. The
   * request's session is the fenced read's caller; the registry rejects a
   * job the session cannot see and an unknown job.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns anchor, coalesced output frames, and the terminal status.
   */
  @Remote({ mode: 'stream' })
  follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> {
    return observeJobOutput(this.ctx.jobs, request, {
      flushMs: this.observeFlushMs,
      maxFrameBytes: this.observeMaxFrameBytes,
    }, signal)
  }

  /**
   * Kill one background job on a human's behalf. The request's session is
   * the fenced read's caller, so the job must be one that session can see:
   * the registry's owner fence is the only access rule, and a child session's
   * own jobs are killable from its list like any other. The kill records
   * `cancelled by the user` as its reason; it is not one the model requested,
   * so the owning agent still receives the completion notice, and a shell
   * tool waiting on that job reads the reason in its own result.
   * @param request - Session whose job list carries the job, and the job id.
   * @returns the registry's admission of the kill request.
   */
  @Remote('kill')
  kill(request: JobKillRequest): JobKillValue {
    const jobs = this.ctx.jobs
    try {
      jobs.get(request.jobId, request.sessionId)
    } catch (error) {
      // `unknown job` and `belongs to another session` both mean this session's
      // list no longer carries a killable row; the client renders one story.
      throw new RemoteError('job/not-found', String(error), {
        sessionId: request.sessionId,
        jobId: request.jobId,
      })
    }
    // Same synchronous span as the lookup, so nothing can remove the job in
    // between — and a producer-cancel throw propagates per the registry
    // contract (job state unchanged) instead of masquerading as job-not-found.
    const outcome = jobs.kill(request.jobId, request.sessionId, 'cancelled by the user')
    return { outcome }
  }
}

export default JobController
