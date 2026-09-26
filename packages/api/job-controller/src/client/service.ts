/**
 * The `ctx.jobs` client service: reference-counted streams over the `job`
 * namespace — one `job.list` roster stream per watched session and one
 * `job.follow` stream per observed job — so overlapping viewers share a
 * stream, rosters resume whole after a reconnect, and observations resume
 * from the model's cursor, plus the human kill passthrough over `job.kill`.
 * @module @deepseek-ai/dsh-api-job-controller/client/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from '../types.ts'
import type { ClientJobsModel, JobsSource } from './model.ts'

/** The generated `job` namespace face the stream runners drive. */
export interface JobRemote {
  /**
   * Open one roster generation.
   * @param request - the session whose visible set to mirror.
   * @param signal - generation cancellation.
   * @returns the whole-set frame sequence of one generation.
   */
  list(request: JobListRequest, signal?: AbortSignal): AsyncIterable<JobListFrame>
  /**
   * Open one observation generation.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - generation cancellation.
   * @returns the frame sequence of one generation.
   */
  follow(request: JobFollowRequest, signal?: AbortSignal): AsyncIterable<JobFollowFrame>
  /**
   * Kill one job on the human's behalf.
   * @param request - the session whose list carries the job, and the job id.
   * @returns the registry's admission, or the business/transport failure.
   */
  kill(request: JobKillRequest): Promise<RemoteResult<JobKillValue>>
}

/** Remote faces the runners drive: the Gateway stream factory and the `job` namespace. */
export interface JobsRemote {
  readonly $stream: ClientRemote['$stream']
  readonly job: JobRemote
}

/** The client jobs service face. */
export interface IJobs {
  /** Rosters and per-job observation state. */
  readonly state: JobsSource
  /**
   * Keep one session's roster current; reference-counted, so two watchers of
   * the same session share one stream and the rows leave with the last.
   * @param sessionId - the session whose visible jobs to mirror.
   * @returns stop function releasing this watcher's reference.
   */
  watchRows(sessionId: SessionId): () => void
  /**
   * Start observing one job's live output; reference-counted, so two viewers
   * of the same job share one stream.
   * @param sessionId - owning session used for the fenced read; undefined for an unowned job.
   * @param id - job to observe.
   * @returns stop function releasing this observer's reference.
   */
  observe(sessionId: SessionId | undefined, id: JobId): () => void
  /**
   * Kill one background job from a session's job list. Pure RPC passthrough:
   * row state converges through the roster stream, and the caller (the
   * job-list control) owns error presentation.
   * @param sessionId - session whose job list carries the job.
   * @param id - the job row's registry id.
   * @returns the registry's admission, or the business/transport failure.
   */
  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>>
}

/** One reference-counted stream. */
interface StreamEntry {
  refs: number
  stopped: boolean
  dispose: () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free client job rosters and observation control. */
    jobs: IJobs
  }
}

/** Owns the bare jobs snapshot and the per-session and per-job streams. */
export class ClientJobs extends Service implements IJobs {
  readonly state: JobsSource
  private readonly rowsEntries = new Map<string, StreamEntry>()
  private readonly observations = new Map<string, StreamEntry>()

  /**
   * @param ctx - client root Context.
   * @param remote - the Gateway stream factory plus the generated `job` namespace, both resolved by the caller.
   * @param model - shared client jobs model.
   */
  constructor(
    ctx: Context,
    private readonly remote: JobsRemote,
    private readonly model: ClientJobsModel,
  ) {
    super(ctx, 'jobs')
    this.state = model
    ctx.effect(() => async () => {
      const open = [...this.rowsEntries.values(), ...this.observations.values()]
      this.rowsEntries.clear()
      this.observations.clear()
      for (const entry of open) entry.stopped = true
      // Cordis awaits an async disposer, so the fiber stays unloading until
      // every carrier iterator has closed and a successor plugin instance
      // cannot overlap one. A carrier whose teardown fails is stopped all the
      // same; its failure has no consumer here.
      await Promise.allSettled(open.map(entry => entry.dispose()))
    }, 'job-controller.client.streams')
  }

  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>> {
    return this.remote.job.kill({ sessionId, jobId: id })
  }

  watchRows(sessionId: SessionId): () => void {
    return this.acquire(
      this.rowsEntries,
      String(sessionId),
      () => this.startRows(sessionId),
      () => { this.model.rowsDropped(sessionId) },
    )
  }

  observe(sessionId: SessionId | undefined, id: JobId): () => void {
    return this.acquire(
      this.observations,
      String(id),
      () => this.startObservation(sessionId, id),
      () => { this.model.observeStopped(id) },
    )
  }

  /** Share the live entry under `key` or start one, and hand back its release. */
  private acquire(
    entries: Map<string, StreamEntry>,
    key: string,
    start: () => StreamEntry,
    cleared: () => void,
  ): () => void {
    const existing = entries.get(key)
    if (existing !== undefined && !existing.stopped) {
      existing.refs += 1
      return this.releaser(entries, key, existing, cleared)
    }
    const entry = start()
    entries.set(key, entry)
    return this.releaser(entries, key, entry, cleared)
  }

  /**
   * Release closures bind the exact entry they were minted for, never the
   * map's current occupant: a later acquire on the same key may have replaced
   * a stopped entry, and decrementing or disposing through the key alone
   * would tear down that newer stream's references.
   */
  private releaser(entries: Map<string, StreamEntry>, key: string, entry: StreamEntry, cleared: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0) return
      if (entries.get(key) === entry) entries.delete(key)
      entry.stopped = true
      void entry.dispose().then(() => {
        // Clear the state only while no successor holds the key: a re-acquire
        // inside the dispose round-trip already refilled the model, and a
        // stale clear would blank it for good.
        if (entries.has(key)) return
        cleared()
      })
    }
  }

  private startRows(sessionId: SessionId): StreamEntry {
    const name = `job rows ${String(sessionId)}`
    const stream = this.remote.$stream<JobListFrame>({
      name,
      open: signal => this.remote.job.list({ sessionId }, signal),
      // The roster has no natural end while it is watched: an end after the
      // first frame is a carrier interruption (a Host reload closes the
      // generation) and the next generation's whole set loses nothing. An end
      // before the first frame is terminal.
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before release`)
        : new Error(`${name} ended before its first frame`),
    })
    const entry: StreamEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    void (async () => {
      try {
        for await (const item of stream) {
          this.model.rowsReplaced(sessionId, item.value.jobs)
          item.accept()
        }
      } catch {
        // A terminal stream failure leaves nothing current to show; the model
        // drops the roster rather than keeping a stale set on screen.
        if (!entry.stopped) this.model.rowsDropped(sessionId)
      } finally {
        entry.stopped = true
        void entry.dispose()
      }
    })()
    return entry
  }

  private startObservation(sessionId: SessionId | undefined, id: JobId): StreamEntry {
    const name = `job observation ${String(id)}`
    const stream = this.remote.$stream<JobFollowFrame>({
      name,
      open: (signal) => {
        const from = this.model.cursorOf(id)
        return this.remote.job.follow(
          {
            jobId: id,
            ...sessionId !== undefined ? { sessionId } : {},
            ...from !== undefined ? { from } : {},
          },
          signal,
        )
      },
      // A premature end after the anchor is retryable (a Host reload closes the
      // generation); resuming from the cursor loses nothing. An end before the
      // anchor is terminal.
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before settlement`)
        : new Error(`${name} ended before its anchor`),
    })
    const entry: StreamEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    void (async () => {
      try {
        for await (const item of stream) {
          const frame = item.value
          if (frame.type === 'opened') {
            this.model.observeOpened(id, frame)
            item.accept()
            continue
          }
          if (frame.type === 'output') {
            this.model.observeOutput(id, frame)
            continue
          }
          // Terminal status: leave the loop before the generation end is
          // classified, then close the stream for good.
          this.model.observeSettled(id)
          break
        }
      } catch (error) {
        if (!entry.stopped) this.model.observeFailed(id, error)
      } finally {
        entry.stopped = true
        void entry.dispose()
      }
    })()
    return entry
  }
}
