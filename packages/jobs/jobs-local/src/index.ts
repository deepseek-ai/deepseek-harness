/**
 * Process-local provider for the background-job capability seam
 * (`ctx.jobs`). It keeps every job — lifecycle state, the bounded output
 * ring, and the model cursor — in memory and hands out fresh projections and
 * chunk copies, never live state.
 *
 * Registrations outlive producer and controller fibers. Agent or service
 * disposal cancels live work and awaits compliant producers; a throwing
 * teardown cancel force-fails only the record and reports a possible orphan.
 * @module @deepseek-ai/dsh-jobs-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { JobRegistry, JobId } from '@deepseek-ai/dsh-jobs'
import type {
  JobAppendOptions, JobEvent, JobEvents, JobHandle, JobKind, JobOutcome, JobOutputRead, JobOutputSource,
  JobRead, JobSettleCause, JobSpec, JobStatus, JobView,
} from '@deepseek-ai/dsh-jobs'
import { JobEventHub, JobLayer } from './events.ts'
import { startPump } from './pump.ts'
import type { PumpHandle } from './pump.ts'
import { OutputRing } from './ring.ts'

/** Timeout code that distinguishes a bounded wait from caller cancellation. */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** Default maximum number of active jobs in one exact-owner bucket. */
const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10

/** Default live ring retention per job, in UTF-8 bytes. */
const DEFAULT_RETAIN_BYTES = 256 * 1024

/** Default ring retention kept after settlement, in UTF-8 bytes. */
const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024

/** Default poll interval for pull sources, in milliseconds. */
const DEFAULT_PUMP_POLL_MS = 150

/** Configuration for the process-local job registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` jobs per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentJobsPerOwner?: number
  /** Live ring retention per job in UTF-8 bytes; omission defaults to 262144. */
  retainBytes?: number
  /**
   * Ring retention kept after a job settles, in UTF-8 bytes; omission defaults to 16384.
   * Settlement keeps every byte the model cursor has not consumed on top of
   * this cap; the first terminal model read then trims to it.
   */
  settledRetainBytes?: number
  /** Poll interval for a job's pull sources, in milliseconds; omission defaults to 150. */
  pumpPollMs?: number
}

/**
 * Producer-written state shared between the {@link JobHandle} and the
 * registered record: the starter call writes through it before the commit,
 * the same object serves the job for its whole life afterwards.
 */
interface ProducerState {
  /** Live progress line until settlement clears it. */
  progress: string | undefined
  /** The committed registry record; undefined exactly during the starter call. */
  job: TrackedJob | undefined
}

/** The registry's mutable per-job record (never handed out — see {@link LocalJobRegistry.view}). */
interface TrackedJob {
  id: JobId
  kind: JobKind
  label: string
  outputLimitBytes: number | undefined
  /** Exact lifecycle owner; session-id authorization is derived from it. */
  owner: Agent | undefined
  cancel: (reason?: string) => void
  status: JobStatus
  ring: OutputRing
  /** The model's consuming cursor; {@link JobRegistry.readAt} never moves it. */
  modelCursor: number
  /** Whether the first post-settlement read already handed out `result`. */
  resultDelivered: boolean
  /** Producer-shared progress line and commit binding. */
  state: ProducerState
  /** Terminal reason; a recorded kill reason is merged in at settlement. */
  detail: string | undefined
  result: string | undefined
  startedAt: number
  finishedAt: number | undefined
  /** Reason recorded by {@link JobRegistry.kill}, merged into a `killed` settlement's detail. */
  killReason: string | undefined
  /** Set once a kill or teardown cancel ran; settlement reports it as the cause. */
  settleCause: JobSettleCause | undefined
  /** Resolves once the terminal record is committed and announced. */
  settled: Promise<void>
  /** Resolver for {@link settled}, called by the first effective settlement. */
  markSettled: () => void
  /** Removable resolvers for live waits; timeout/abort unregister before the job settles. */
  waitResolvers: Set<() => void>
  /** The registry-owned pump over the spec's pull sources, when it named any. */
  pump: PumpHandle | undefined
  /**
   * The spill file each pull source reported on its latest read, by source
   * index; an entry is undefined while that source keeps none. Source
   * metadata rather than per-chunk metadata, so it survives ring eviction and
   * follows a source that withdraws its file.
   */
  spillPaths: (string | undefined)[]
}

/** True for the three terminal {@link JobStatus} values. */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * The in-memory `jobs` registry. See the Service Definition contract in
 * `@deepseek-ai/dsh-jobs` for the ownership, isolation, and lifecycle
 * semantics this implementation honors.
 */
export class LocalJobRegistry extends JobRegistry {
  static Config: z<Config> = z.object({
    maxConcurrentJobsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER),
    retainBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_RETAIN_BYTES),
    settledRetainBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_SETTLED_RETAIN_BYTES),
    pumpPollMs: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_PUMP_POLL_MS),
  })

  /** Schemastery-defaulted active-job limit. */
  private readonly maxConcurrentJobsPerOwner: number
  /** Schemastery-defaulted live ring retention cap. */
  private readonly retainBytes: number
  /** Schemastery-defaulted settled ring retention cap. */
  private readonly settledRetainBytes: number
  /** Schemastery-defaulted pull-source poll interval. */
  private readonly pumpPollMs: number
  private store = new Map<JobId, TrackedJob>()
  private counters = new Map<string, number>()
  /**
   * Controllers and scoped subscriptions layered by the scope that registered
   * them, in the tools-registry shape: a contribution files into its
   * registering context's scope, and a read unions the global layer with the
   * owner's scope chain.
   *
   * The registry is one process-wide instance serving every composition, so a
   * flat table would answer a per-owner question process-wide: one preset's
   * job controls would hold `start()` open for an agent whose own composition
   * loads none, and one settlement would reach every preset's notice listener.
   * Layers make both reads owner-relative. Nothing derives a cache from a
   * layer, so change notification is a no-op.
   */
  private readonly layers = new ScopedLayers<JobLayer>(() => new JobLayer(), () => {})
  private readonly hub: JobEventHub
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by detached settlement continuations and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills the defaults before constructing the service.
    const resolved = config as Required<Config>
    this.maxConcurrentJobsPerOwner = resolved.maxConcurrentJobsPerOwner
    this.retainBytes = resolved.retainBytes
    this.settledRetainBytes = resolved.settledRetainBytes
    this.pumpPollMs = resolved.pumpPollMs
    this.selfCtx = ctx
    this.hub = new JobEventHub(this.layers, (message) => { ctx.logger.warn(message) })
    ctx.effect(() => () => this.disposeAll(), 'jobs teardown')
  }

  /**
   * The event stream bound to the accessing context: a subscription is an
   * effect of that context, and `{ owners: 'scope' }` names its scope.
   */
  get events(): JobEvents {
    const registrar = this.ctx
    return {
      subscribe: (filter, listener) => this.hub.subscribe(registrar, filter, listener),
    }
  }

  start(spec: JobSpec): JobId {
    const owner = this.resolveOwner(spec.owner)
    if (!this.servesOwner(owner)) {
      throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
    }
    if (spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined
      && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new Error(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (owner !== undefined) this.ensureOwnerCleanup(owner)

    const active = this.activeJobCount(owner)
    if (active >= this.maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }

    // The id is issued before the starter runs so the producer face can carry
    // it; a throwing starter still leaves nothing registered — its ordinal is
    // simply skipped.
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = JobId(`${spec.kind}-${count}`)
    const ring = new OutputRing()
    const state: ProducerState = { progress: undefined, job: undefined }
    const handle: JobHandle = {
      id,
      append: (text, options) => { this.appendRing(state, ring, text, options, 'producer') },
      updateProgress: (line) => { this.updateProgress(state, line) },
    }
    const hooks = spec.run(handle)

    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const job: TrackedJob = {
      id,
      kind: spec.kind,
      label: spec.label,
      outputLimitBytes: spec.outputLimitBytes,
      owner,
      cancel: hooks.cancel.bind(hooks),
      status: 'running',
      ring,
      modelCursor: 0,
      resultDelivered: false,
      state,
      detail: undefined,
      result: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      killReason: undefined,
      settleCause: undefined,
      settled,
      markSettled,
      waitResolvers: new Set(),
      pump: undefined,
      spillPaths: [],
    }
    // Binding the shared producer state is the commit: writes staged inside
    // the starter are already in the ring and `state`, and every later handle
    // call reaches the registered record for its terminal checks and signals.
    state.job = job
    this.store.set(id, job)
    // Registration is complete and cannot fail from here, so the visible set
    // has genuinely changed. The announcement precedes the pump because the
    // pump drains its sources once synchronously, and that drain may append
    // and announce output: a job's first event is always `registered`.
    this.emit({ type: 'registered', job: this.view(job) }, owner)

    // The producer's settlement or a registry-forced one ends the pump; the
    // pump's final drain then lands before this registry trims the ring.
    const producerDone = hooks.done.then(
      outcome => outcome,
      (error: unknown): JobOutcome => {
        // Contain a producer contract violation (`done` rejected) so cleanup and waiters cannot hang.
        this.selfCtx.logger.warn(`jobs: job ${job.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        return { status: 'failed', detail: String(error) }
      },
    )
    if (spec.output !== undefined && spec.output.length > 0) {
      job.pump = startPump(
        spec.output.map(source => this.guardSource(job, source)),
        {
          append: (text, options) => { this.appendRing(state, ring, text, options, 'pump') },
          spill: (index, path) => { job.spillPaths[index] = path },
        },
        this.pumpPollMs,
        Promise.race([producerDone, settled]),
      )
    }
    void producerDone.then(async (outcome) => {
      if (job.pump !== undefined) await job.pump.done
      this.settle(job, outcome, job.settleCause ?? 'producer')
    })
    return id
  }

  list(caller?: SessionId): JobView[] {
    return [...this.store.values()]
      .filter(job => job.owner === undefined || job.owner.id === caller)
      .map(job => this.view(job))
  }

  get(id: JobId, caller?: SessionId): JobView {
    return this.view(this.expect(id, caller))
  }

  read(id: JobId, caller?: SessionId): JobRead {
    return this.readJob(this.expect(id, caller))
  }

  readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead {
    const job = this.expect(id, caller)
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new Error(`invalid output read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`)
    }
    return job.ring.readFrom(from)
  }

  kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished' {
    return this.killJob(this.expect(id, caller), reason)
  }

  async wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView> {
    return this.waitJob(this.expect(id, caller), timeoutMs, signal)
  }

  remove(id: JobId, caller?: SessionId): void {
    const job = this.expect(id, caller)
    if (!isTerminal(job.status)) throw new Error(`job ${id} is still ${job.status}; kill it and wait for settlement before removing it`)
    this.drop([job])
  }

  attachController(name: string): () => void {
    // One token per call keeps duplicate labels independently disposable.
    const token = Symbol(name)
    return this.layers.effect(
      this.ctx,
      layer => layer.controllers.append(token),
      { label: 'jobs.attachController()' },
    )
  }

  /**
   * Resolve a spec's owner session to its live Agent. An owned registration
   * needs the agent registry, and the session must currently have a live
   * instance: that instance's disposal is what cancels and drops the job.
   */
  private resolveOwner(session: SessionId | undefined): Agent | undefined {
    if (session === undefined) return undefined
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    const owner = agents.get(session)
    if (owner === undefined) {
      throw new Error(`session "${session}" has no live agent (background job owner must be live)`)
    }
    return owner
  }

  /**
   * Whether an attached job controller can collect and stop work owned by
   * `owner`. The global layer holds every controller attached from an unscoped
   * context — a host composition's own controls — and therefore serves every
   * owner; a scoped controller serves exactly the agents composed under it.
   * @param owner - the job's owner, or undefined for unowned work.
   * @returns whether some reachable controller serves the owner.
   */
  private servesOwner(owner?: Agent): boolean {
    if (!this.layers.global.controllers.isEmpty()) return true
    return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
      .some(layer => !layer.controllers.isEmpty())
  }

  /** Count authoritative active records for one exact owner or the shared unowned bucket. */
  private activeJobCount(owner: Agent | undefined): number {
    let count = 0
    for (const job of this.store.values()) {
      if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
    }
    return count
  }

  /** Look up a job and enforce caller access. */
  private expect(id: JobId, caller?: SessionId): TrackedJob {
    const job = this.store.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    return job
  }

  /**
   * The isolation fence: a job with an owner is reachable only by callers
   * whose session id matches (`!== undefined` semantics — an unowned job is
   * open, and a caller-less view can never match an owned one).
   */
  private assertAccess(job: TrackedJob, caller: SessionId | undefined): void {
    if (job.owner !== undefined && job.owner.id !== caller) {
      throw new Error(`job ${job.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only view from the mutable record. */
  private view(job: TrackedJob): JobView {
    const owner = job.owner?.id
    const spillPaths = [...new Set(job.spillPaths.filter((path): path is string => path !== undefined))]
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...owner !== undefined ? { owner } : {},
      ...job.outputLimitBytes !== undefined ? { outputLimitBytes: job.outputLimitBytes } : {},
      status: job.status,
      ...job.state.progress !== undefined ? { progress: job.state.progress } : {},
      ...job.detail !== undefined ? { detail: job.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      output: {
        total: job.ring.total,
        earliest: job.ring.earliest,
        ...spillPaths.length > 0 ? { spillPaths } : {},
      },
    }
  }

  private emit(event: JobEvent, owner: Agent | undefined): void {
    this.hub.emit(event, owner)
  }

  /**
   * Consume the ring from the model cursor; the result rides the first read
   * after settlement. A terminal read is the point the settled stream drops
   * to the settled cap: settlement kept every unconsumed byte for it.
   */
  private readJob(job: TrackedJob): JobRead {
    const read = job.ring.readFrom(job.modelCursor)
    job.modelCursor = job.ring.total
    const result = isTerminal(job.status) && !job.resultDelivered ? job.result : undefined
    if (result !== undefined) job.resultDelivered = true
    if (isTerminal(job.status)) job.ring.trim(this.settledRetainBytes)
    return {
      chunks: read.chunks,
      lossy: read.lossy,
      ...result !== undefined ? { result } : {},
      job: this.view(job),
    }
  }

  private killJob(job: TrackedJob, reason?: string): 'requested' | 'already-finished' {
    if (isTerminal(job.status)) return 'already-finished'
    // Cancel first so a throw leaves lifecycle state unchanged.
    job.cancel(reason)
    job.status = 'stopping'
    // Last writer wins on purpose: the detail reports the latest kill intent.
    if (reason !== undefined) job.killReason = reason
    job.settleCause = 'kill'
    this.emit({ type: 'stopping', job: this.view(job) }, job.owner)
    return 'requested'
  }

  private async waitJob(job: TrackedJob, timeoutMs: number, signal?: AbortSignal): Promise<JobView> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // The scoped deadline distinguishes a successful wait timeout from
      // caller cancellation and clears its timer on every exit.
      using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
      await new Promise<void>((resolve, reject) => {
        const onSettled = (): void => {
          job.waitResolvers.delete(onSettled)
          d.signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          job.waitResolvers.delete(onSettled)
          // A settled job cannot reach here: settlement releases every waiter
          // before it announces, and each released waiter detaches this
          // listener in the same synchronous span, so nothing that reacts to a
          // settlement can abort a wait the settlement already owed.
          if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
            resolve()
          } else {
            reject(new Error('wait aborted'))
          }
        }
        job.waitResolvers.add(onSettled)
        d.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    return this.view(job)
  }

  /**
   * Append one chunk to the ring. A producer chunk against a settled job is
   * logged and dropped; the registry's own pump drains silently after
   * settlement (a forced settlement may precede the producer's). A chunk
   * staged inside the starter call is retained and signals no observer — the
   * registration commit publishes it.
   */
  private appendRing(
    state: ProducerState,
    ring: OutputRing,
    text: string,
    options: JobAppendOptions | undefined,
    writer: 'producer' | 'pump',
  ): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      if (writer === 'producer') this.selfCtx.logger.warn(`jobs: append to settled job ${job.id} dropped`)
      return
    }
    if (!ring.append(text, options, this.retainBytes)) return
    if (job !== undefined) this.emitOutput(job)
  }

  /**
   * Contain a failing pull source: the first throw is logged, and the source
   * reads as exhausted from then on, so the job runs to its own settlement
   * with whatever the ring holds instead of freezing on a pump failure.
   */
  private guardSource(job: TrackedJob, source: JobOutputSource): JobOutputSource {
    let failed = false
    return {
      ...source.channel !== undefined ? { channel: source.channel } : {},
      read: (fromByte) => {
        if (failed) return { text: '', nextOffset: fromByte, lossy: false }
        try {
          return source.read(fromByte)
        } catch (error: unknown) {
          failed = true
          this.selfCtx.logger.warn(`jobs: output source for ${job.id} failed; its stream stops here: ${String(error)}`)
          return { text: '', nextOffset: fromByte, lossy: false }
        }
      },
    }
  }

  /** Announce that one job's ring advanced (append or settlement). */
  private emitOutput(job: TrackedJob): void {
    const owner = job.owner?.id
    this.emit({ type: 'output', id: job.id, ...owner !== undefined ? { owner } : {}, total: job.ring.total }, job.owner)
  }

  /**
   * Replace the live progress line through a producer face; a write against a
   * settled job is logged and dropped. A write staged inside the starter call
   * seeds the registered projection and signals no observer.
   */
  private updateProgress(state: ProducerState, line: string): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      this.selfCtx.logger.warn(`jobs: progress update on settled job ${job.id} dropped`)
      return
    }
    state.progress = line
    if (job !== undefined) this.emit({ type: 'progress', job: this.view(job) }, job.owner)
  }

  /**
   * Record the first terminal outcome, release waiters, then announce the
   * settlement. First-wins preserves a teardown force-failure against late
   * producer settlement. The settled event follows every released waiter and
   * reports whether it released one: a timed-out or aborted wait has already
   * left the set, so only a wait still owed the projection counts.
   */
  private settle(job: TrackedJob, outcome: JobOutcome, cause: JobSettleCause): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    // A killed settlement carries the recorded kill reason in its detail:
    // producer facts first (`signal: SIGTERM; cancelled by the user`). A job
    // that outran its kill request (settled `completed`/`failed`) keeps the
    // producer detail alone — the reason describes a kill that never landed.
    if (outcome.status === 'killed' && job.killReason !== undefined) {
      job.detail = outcome.detail !== undefined
        ? `${outcome.detail}; ${job.killReason}`
        : job.killReason
    } else if (outcome.detail !== undefined) {
      job.detail = outcome.detail
    }
    job.state.progress = undefined
    job.result = outcome.result
    job.finishedAt = Date.now()
    // Settlement ends the stream: trim to the settled cap before any observer
    // reads the terminal projection, but never below the bytes the model
    // cursor has not consumed. A job that finishes before its first model
    // read keeps everything the live cap retained until that read.
    job.ring.trim(Math.max(this.settledRetainBytes, job.ring.total - job.modelCursor))
    const waitResolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    job.markSettled()
    this.emit({ type: 'settled', job: this.view(job), cause, awaited: waitResolvers.length > 0 }, job.owner)
    // The ring's stream ends with settlement; the signal follows the committed
    // settlement so an observer that wakes on it reads the terminal state.
    this.emitOutput(job)
  }

  /**
   * Attach one awaited cleanup through the exact owner's scope. This survives
   * producer reloads and joins agent quiescence; the retained disposer lets
   * service teardown detach the cross-fiber effect.
   */
  private ensureOwnerCleanup(owner: Agent): void {
    if (this.ownerCleanups.has(owner)) return
    // Record only after attach succeeds; a disposing scope rejects new effects.
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'jobs.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
  private async disposeOwned(owner: Agent): Promise<void> {
    const owned = [...this.store.values()].filter(job => job.owner === owner)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(job => job.settled))
    this.drop(owned)
  }

  /** Drop settled records and announce each removal, the one visible-set change no per-job record carries. */
  private drop(jobs: readonly TrackedJob[]): void {
    for (const job of jobs) {
      this.store.delete(job.id)
      this.emit({ type: 'removed', job: this.view(job) }, job.owner)
    }
  }

  /**
   * Cancel live jobs, await settlement, drop every record, and detach owner
   * effects. Throwing cancels are force-failed to avoid teardown deadlock.
   */
  private async disposeAll(): Promise<void> {
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs service disposed')
    await Promise.all(all.map(job => job.settled))
    // A subscriber mounted outside this service — the job controller's rows
    // stream registers from its own context — is still reachable here.
    // Without the removals it keeps the rows it last received after a
    // registry reload.
    this.drop(all)
    // Detach cross-fiber owner effects after the shared store is quiescent.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * Cancel jobs during teardown with per-job containment. A throwing cancel
   * force-fails the record and reports a possible orphan; a cancel that returns
   * without settling remains indistinguishable from a slow stop and may stall.
   */
  private cancelForTeardown(jobs: TrackedJob[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      // Whatever settles this job from here on, its owner or the service is
      // being destroyed: the settlement announces `teardown` so a completion
      // reporter does not address a reader that no longer exists.
      job.settleCause = 'teardown'
      try {
        job.cancel(reason)
        job.status = 'stopping'
        // Teardown reaches settlement only after the producer releases, which a
        // slow stop can defer; announcing the transition here is what keeps an
        // observer from showing `running` for that whole window.
        this.emit({ type: 'stopping', job: this.view(job) }, job.owner)
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(job, { status: 'failed', detail }, 'teardown')
      }
    }
  }
}

export default LocalJobRegistry
