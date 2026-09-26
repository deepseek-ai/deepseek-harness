/**
 * The background-job Service Definition (`ctx.jobs`). It owns the contract for
 * job ids, session-scoped access, lifecycle state, the per-job output ring —
 * one bounded stream that the model consumes through a registry-kept cursor
 * and that any number of observers read at absolute byte offsets — and the
 * event stream announcing every commit, while producers retain their
 * execution resources. The process-local registry lives in
 * `@deepseek-ai/dsh-jobs-local`.
 * @module @deepseek-ai/dsh-jobs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installJobArchiveAdmission } from './archive-admission.ts'
import type { JobEvents, JobId, JobOutputRead, JobRead, JobSpec, JobView } from './types.ts'

export { JobId } from './types.ts'
export type {
  JobAppendOptions,
  JobChannel,
  JobChunk,
  JobEvent,
  JobEventFilter,
  JobEventListener,
  JobEvents,
  JobHandle,
  JobHooks,
  JobKind,
  JobKindMap,
  JobOutcome,
  JobOutputRead,
  JobOutputSource,
  JobRead,
  JobSettleCause,
  JobSourceRead,
  JobSpec,
  JobStatus,
  JobView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobRegistry
  }
}

/**
 * Abstract background job registry. Subclass, implement the abstract members,
 * and load the subclass as a plugin — it registers as `ctx.jobs` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Registrations outlive producer and controller fibers. Owner and
 *   service disposal cancel live work and await compliant producers; a
 *   throwing teardown cancel force-fails only the record. Such settlements
 *   announce `cause: 'teardown'`, because a job whose owner is being destroyed
 *   has no reader left.
 * - Owned-job access is fenced by the owner's session id. Ids are
 *   predictable, so authorization — not secrecy — is the boundary.
 * - Settlement is first-wins: one terminal record, released waiters, then one
 *   round of contained event delivery, even against a late producer outcome.
 *   The `settled` event follows every released waiter and reports whether it
 *   released one (`awaited`), so a completion reporter can skip settlements a
 *   waiting caller already collected.
 * - A settled record stays listed until its owner's disposal, service
 *   disposal, or an explicit {@link remove} by a caller that collected the
 *   terminal state itself and never handed the id out.
 * - {@link start} refuses work while no attached job controller serves the
 *   spec's owner, so a producer cannot start work that owner cannot collect
 *   or stop. One registry serves every composition in the process, so this
 *   question — and event delivery under `{ owners: 'scope' }` — is
 *   owner-relative rather than process-wide: registrations made from an
 *   unscoped context serve every owner, and registrations made under an agent
 *   composition's scope serve exactly the agents composed under it.
 * - Every job owns one output ring. Pull sources named by the spec are pumped
 *   by the registry and drained once more before settlement; pushed appends
 *   land whole. The model's consuming cursor and observers' absolute offsets
 *   read the same bytes and never disturb each other.
 * - Ring retention is bounded. Appends past the live cap drop the oldest
 *   retained bytes; a reader below the retained window gets a lossy read,
 *   never an error. Settlement trims retention to the settled cap and ends
 *   the stream; the ring has no separate lifecycle.
 */
export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this package
    // would register a ctx.jobs with no method implementations and fail far
    // from the misconfiguration. Fail loud at load instead.
    if (new.target === JobRegistry) {
      throw new Error('@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead')
    }
    super(ctx, 'jobs')
    // Archive admission: the Workspace registry asks what still runs for a
    // Session before hiding it; owned jobs answer here for every implementation.
    installJobArchiveAdmission(ctx, this)
  }

  /** Lifecycle and output events, filtered per subscription. */
  abstract readonly events: JobEvents

  /**
   * Preflight access, validation, owner cleanup, and implementation-owned
   * admission before starting and atomically registering work. Any preflight
   * rejection leaves no job id or execution resource. A throwing starter
   * leaves nothing registered; after it returns, registration cannot fail.
   * @param spec - job identity, owner, output sources, and synchronous starter.
   * @returns the registry-issued `<kind>-N` id.
   */
  abstract start(spec: JobSpec): JobId

  /**
   * List caller-owned and unowned jobs in registration order.
   * @param caller - reading session; omission sees only unowned jobs.
   * @returns fresh projections.
   */
  abstract list(caller?: SessionId): JobView[]

  /**
   * Project one job without changing its cursor. Throws for an unknown or
   * foreign job.
   * @param id - job to look up.
   * @param caller - reading session checked against the owner.
   * @returns a fresh projection.
   */
  abstract get(id: JobId, caller?: SessionId): JobView

  /**
   * Consume the ring from the model cursor and advance it to the current
   * total. After settlement the first read also carries the producer's
   * result. Throws for an unknown or foreign job.
   * @param id - job to read.
   * @param caller - reading session checked against the owner.
   * @returns the chunks since the cursor, the lossy flag, the result once, and the post-read projection.
   */
  abstract read(id: JobId, caller?: SessionId): JobRead

  /**
   * Read retained ring output without moving the model cursor. Resume with
   * a previous read's `next`; an offset inside a retained chunk returns the
   * whole chunk (its `at` may precede `from`). Throws for a negative or
   * non-integer offset, or an unknown or foreign job.
   * @param id - job to read.
   * @param from - absolute byte offset to read from (0 for the retained head).
   * @param caller - reading session checked against the owner.
   * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
   */
  abstract readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead

  /**
   * Request cancellation, then mark the job stopping. A producer throw
   * propagates without changing job state. A supplied reason is merged into
   * terminal `detail` when the job settles `killed`. Throws for an unknown
   * or foreign job.
   * @param id - job to cancel.
   * @param caller - killing session checked against the owner.
   * @param reason - cancellation reason forwarded verbatim to the producer.
   * @returns `requested` for live work, otherwise `already-finished`.
   */
  abstract kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished'

  /**
   * Wait for settlement or timeout without cancelling the job. Caller abort
   * rejects only while the job is live; after settlement the terminal
   * projection wins. Rejects for an invalid timeout or an unknown or foreign
   * job.
   * @param id - job to wait for.
   * @param timeoutMs - positive finite wait bound in milliseconds.
   * @param caller - waiting session checked against the owner.
   * @param signal - optional cancellation of the wait itself.
   * @returns projection at settlement or timeout.
   */
  abstract wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>

  /**
   * Drop one settled job's record from the visible set and announce
   * `removed`. For a caller that collected the terminal state through its own
   * {@link wait} and never handed the id to the model, such as a shell tool's
   * foreground call. Throws for a job that is still live, unknown, or foreign.
   * @param id - settled job to drop.
   * @param caller - removing session checked against the owner.
   */
  abstract remove(id: JobId, caller?: SessionId): void

  /**
   * Attach an effect-scoped controller that can read and stop jobs. It serves the
   * owners its registering context's scope covers, and {@link start} refuses an
   * owner no attached controller serves.
   * @param name - diagnostic label; duplicate names remain independent.
   * @returns disposer that detaches this controller.
   */
  abstract attachController(name: string): () => void
}

export default JobRegistry
