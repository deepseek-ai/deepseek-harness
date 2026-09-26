# Background Job Runtime

English | [中文](jobs.zh.md)

Types shared by long-running producers, `ctx.jobs`, and job controls. The [seam consolidation Agent Note](../../.agents/notes/implemented/architecture/2026-09-03-jobs-seam-consolidation.md) owns the current design and the [runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) its origin; this page records the exact fields and variants from [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts) and the client-safe [`view.ts`](../../packages/jobs/jobs/src/view.ts) leaf.

## Ids and status

`JobId` is a [branded id](core.md#branded-ids) generated as `<kind>-N`. Access control relies on owner authorization, not id secrecy. `JobKind` derives from a merge-extensible map; the registry treats kinds as opaque id namespaces.

```ts type-equiv
/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
```

`JobStatus` is `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`; producer-specific facts belong in `JobView.progress` while the job runs and in `JobView.detail` once it settled.

## Producer contract

A `JobSpec` declares identity, the owning session, optional pull `output` sources, and a starter. The runtime finishes preflight before calling `run()` with the job's `JobHandle` and commits without a later failable step. Producers own execution resources; the runtime owns identity, access, lifecycle state, and the output ring.

```ts type-equiv
/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity, lifecycle state, and
 * the output ring.
 */
interface JobSpec {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Owning session. Access is fenced by it, and the owner's live Agent must be
   * the one currently registered under that id: its disposal cancels and
   * awaits the job. Omitting the owner creates an unowned job, open to any
   * caller until service disposal.
   */
  owner?: SessionId
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata. Independent of ring
   * retention: it bounds the consuming model surface, never observers.
   */
  outputLimitBytes?: number
  /**
   * Pull sources the registry pumps into the ring at its own cadence.
   * Producers that narrate their own progress use {@link JobHandle.append}
   * instead; a job may use both.
   */
  output?: readonly JobOutputSource[]
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the ring append and progress writers.
   */
  run(job: JobHandle): JobHooks
}
```

```ts type-equiv
/**
 * Producer face of one registered job, handed to {@link JobSpec.run} and
 * valid for the job's whole life. All methods are synchronous. Writes staged
 * inside the starter call are retained and become visible with the
 * registration commit; after settlement — the producer's own outcome, a kill,
 * or a registry-forced teardown end — writes log and drop instead of
 * throwing, so a producer's trailing flush cannot break its own teardown path.
 */
interface JobHandle {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * Append one chunk to the output ring. Offsets advance by the chunk's UTF-8
   * byte length; an empty chunk is dropped without waking observers.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   */
  append(text: string, options?: JobAppendOptions): void
  /**
   * Replace the live progress line (`3/10`, the current phase). Settlement
   * clears it; the terminal reason travels in {@link JobOutcome.detail}.
   * @param line - the new progress line.
   */
  updateProgress(line: string): void
}
```

`JobHooks.done` resolves after the producer releases its resources, not merely when work finishes. A job whose result is a value rather than a stream — a subagent's report, a workflow's rendered result — returns it as `JobOutcome.result`; the model's first read after settlement carries it once.

```ts type-equiv
/** Hooks through which the runtime controls and observes producer work. */
interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped.
   */
  done: Promise<JobOutcome>
}
```

```ts type-equiv
/** Terminal result supplied by a producer through {@link JobHooks.done}. */
interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /**
   * Terminal reason rendered into status lines (`exit code: 3`, `max-tokens`).
   * When the job settles `killed` after a {@link JobRegistry.kill} with a
   * reason, the registry appends that reason.
   */
  detail?: string
  /**
   * Return value for jobs whose result is a value rather than a stream (a
   * workflow's rendered result, a subagent's report). The output ring carries
   * the stream; this is handed out once by the model's next {@link JobRegistry.read}.
   */
  result?: string
}
```

A pull source hands the registry a non-consuming offset reader — the subprocess `readFrom` family. The registry pumps every source at its own cadence (`pumpPollMs` on `dsh-jobs-local`) and drains it once more before settlement closes the ring, so producers fold nothing into `done`.

```ts type-equiv
/**
 * A pull source the registry pumps into the job's output ring — the subprocess
 * `readFrom` family. The registry owns the cadence and drains every source one
 * last time before settlement closes the ring, so a producer folds nothing
 * into its `done`.
 */
interface JobOutputSource {
  /** Stream label attached to every chunk this source yields. */
  channel?: JobChannel
  /**
   * Read everything captured since `fromByte` without consuming it.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 first).
   * @returns the delta text, the next offset, the lossy flag, and the spill path the source currently keeps.
   */
  read(fromByte: number): JobSourceRead
}
```

```ts type-equiv
/** One incremental read from a {@link JobOutputSource}. */
interface JobSourceRead {
  /** Text captured since the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the source's retained window. */
  lossy: boolean
  /**
   * Host path of a file holding the complete stream, when the source
   * currently keeps an intact one. Reported on every read, so the registry
   * tracks it as source metadata: a later read without it withdraws the file.
   */
  spillPath?: string
}
```

## The output ring

Every job owns one bounded ring. Pull sources are pumped into it and `JobHandle.append` pushes land whole; the model consumes the ring through a registry-kept cursor (`JobRegistry.read`), any number of observers read it at absolute byte offsets (`JobRegistry.readAt`), and neither disturbs the other. `JobChannel` labels `stdout`, `stderr`, and `log`; `log` is producer narration that reaches observers only, never the model's consuming read. Settlement ends the stream and trims retention to the settled cap — the ring has no separate lifecycle. The spill file a pull source keeps is job metadata (`JobView.output.spillPaths`, refreshed by every pump read), not per-chunk metadata, so the model's dropped-output notice names it after the ring evicted the bytes and even after the gap chunk itself is gone. Browsers reach the roster and the ring through `job.list` and `job.follow`, the Remote streams of [`dsh-api-job-controller`](../../packages/api/job-controller/README.md), whose frames are listed under its Cordis API section below.

```ts type-equiv
/** One chunk of a job's output ring: absolute offset, text, channel, and loss marker. */
interface JobChunk {
  /** Absolute offset of the chunk's first byte; offsets never move once assigned. */
  readonly at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  readonly text: string
  /** Stream label, when the producer supplied one. */
  readonly channel?: JobChannel
  /** Bytes immediately before this chunk were lost, at the producer or to retention. */
  readonly gapBefore?: true
}
```

```ts type-equiv
/** Result of one non-consuming {@link JobRegistry.readAt}. */
interface JobOutputRead {
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: readonly JobChunk[]
  /**
   * Offset to resume from — the ring's current `total`. Always a chunk
   * boundary: appends land whole and trimming only advances chunk starts, and
   * consumers concatenate `chunks` under that assumption, so a provider
   * serving partial chunks would silently duplicate text.
   */
  next: number
  /** True when `from` fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
}
```

## Consumer views

`JobView` is the one projection every reader consumes: the model tools, the browser roster, and the observation stream. `owner` carries the session id that fences access; the registry resolves the live `Agent` behind it for lifecycle cleanup and never hands the object out. `progress` is the producer's live line and is cleared at settlement; `detail` is the terminal reason, with a recorded kill reason merged in.

```ts type-equiv
/**
 * Read-only projection of one job — a fresh object per call, never live
 * registry state. The model tools, the browser roster, and the observation
 * stream all consume this one shape.
 */
interface JobView {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * The producer kind the job was registered with: a Host-registered
   * `JobKind`, carried as an open string because a browser bundle or a Remote
   * codec sees only the `JobKindMap` merges its own program compiles.
   */
  readonly kind: string
  /** The producer-supplied one-line label. */
  readonly label: string
  /** Owning session; absent for an unowned job, which every caller can see. */
  readonly owner?: SessionId
  /** Producer-owned cap for complete model-facing notices and reads, in UTF-8 bytes. */
  readonly outputLimitBytes?: number
  /** Current lifecycle state. */
  readonly status: JobStatus
  /** The producer's live progress line (`3/10`, the current phase); cleared at settlement. */
  readonly progress?: string
  /** Terminal reason (`exit code: 3`); a recorded kill reason is merged in. */
  readonly detail?: string
  /** Epoch ms when the job was registered. */
  readonly startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  readonly finishedAt?: number
  /**
   * The output ring's absolute coordinates and the complete-stream files
   * behind it. `total` is the offset the next chunk starts at (0 while
   * nothing was written); `earliest` is the oldest retained byte, greater
   * than zero exactly when retention dropped the head. `spillPaths` lists the
   * spill files the job's pull sources currently keep, in source order and
   * deduplicated, and is absent while no source keeps one: it outlives any
   * chunk, so a reader below `earliest` can still name where the bytes went.
   */
  readonly output: { readonly total: number; readonly earliest: number; readonly spillPaths?: readonly string[] }
}
```

`JobRegistry.list`, `get`, `read`, `readAt`, `kill`, and `wait` each accept the caller’s `SessionId`; omitting it permits only unowned jobs, while a session may also access its own jobs.

```ts type-equiv
/** Output and post-read state returned by the consuming {@link JobRegistry.read}. */
interface JobRead {
  /** Ring chunks appended since the model cursor, in offset order; every channel included. */
  chunks: readonly JobChunk[]
  /** True when the cursor fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
  /** The producer's {@link JobOutcome.result}, handed out by the first read after settlement only. */
  result?: string
  /** The job's state at read time. */
  job: JobView
}
```

## Events

The registry announces every commit through one filtered stream. Lifecycle events carry the projection after the commit they announce; `settled` names its cause so a completion reporter can skip a teardown; `output` carries only the id and the new total, so observers read from their own cursor and the registry never pushes payloads.

```ts type-equiv
/**
 * One lifecycle or output event. Lifecycle events carry the job's projection
 * after the commit they announce; `output` carries only the id and the new
 * total, so an observer schedules a {@link JobRegistry.readAt} from its own
 * cursor and the registry never pushes payloads.
 */
type JobEvent =
  | {
    /** Registration commit, progress line change, stopping transition, or removal from the visible set. */
    readonly type: 'registered' | 'progress' | 'stopping' | 'removed'
    readonly job: JobView
  }
  | {
    readonly type: 'settled'
    readonly job: JobView
    readonly cause: JobSettleCause
    /**
     * Whether this settlement released a live {@link JobRegistry.wait}. That
     * waiter's caller receives the terminal projection as its own result, so
     * a completion reporter treats an awaited settlement as already delivered
     * and reports only the unawaited ones. A wait that timed out or was
     * aborted before the settlement does not count.
     */
    readonly awaited: boolean
  }
  | {
    readonly type: 'output'
    readonly id: JobId
    /** Owning session, absent for an unowned job. */
    readonly owner?: SessionId
    /** The ring's total after the append (or at settlement, which ends the stream). */
    readonly total: number
  }
```

```ts type-equiv
/**
 * Who a subscription hears about. `{ owner }` delivers that session's jobs
 * plus every unowned job (the set that session can see). `{ owners: 'scope' }`
 * delivers the owners composed under the subscribing context — one registry
 * serves every composition in the process, and a mount under one preset must
 * not hear another preset's agents. `{ owners: 'all' }` delivers everything.
 */
type JobEventFilter =
  | { readonly owner: SessionId }
  | { readonly owners: 'all' | 'scope' }
```

## Service behavior

The abstract [`JobRegistry`](../../packages/jobs/jobs/src/index.ts) Service Definition specifies atomic `start`, caller-scoped `list`, `get`, consuming `read`, non-consuming `readAt`, `kill`, and bounded `wait`, the filtered `events` stream, and `attachController`; [`LocalJobRegistry`](../../packages/jobs/jobs-local/src/index.ts) is the process-local Service Provider. Authorization compares owner sessions; owner cleanup and admission use the live `Agent` registered under the owner session when the job starts. The local provider's positive-safe-integer `maxConcurrentJobsPerOwner` config defaults to `10` and counts `running` plus `stopping` records per exact owner, with one shared bucket for unowned jobs; terminal producer settlement releases capacity; `retainBytes` (default 262144) and `settledRetainBytes` (default 16384) bound each ring's live and settled retention, and `pumpPollMs` (default 150) is the pull cadence. See [`dsh-jobs`](../../packages/jobs/jobs/README.md) for the Service Definition contract, [`dsh-jobs-local`](../../packages/jobs/jobs-local/README.md) for the registry lifecycle and admission policy, and [`dsh-tool-jobs`](../../packages/jobs/tool-jobs/README.md) for the model-facing Consumer.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjobcontroller--jobcontroller"></a>

### `ctx.jobController` — `JobController`

Host service backing the generated `ctx.remote.job` namespace.

```ts cordis-catalog
/**
 * Stream the jobs one session can see — its own plus every unowned job —
 * as whole-set frames: one on open, then one after each coalesced burst of
 * lifecycle commits. The stream has no natural end; the carrier closes it.
 * @param request - the session whose visible set to mirror.
 * @param signal - cancellation owned by the Remote stream carrier.
 * @returns the roster frames.
 */
@Remote({ mode: 'stream' }) list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame>

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
@Remote({ mode: 'stream' }) follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame>

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
@Remote('kill') kill(request: JobKillRequest): JobKillValue
```

Source: [`packages/api/job-controller/src/index.ts`](../../packages/api/job-controller/src/index.ts)

<a id="ctxjobs--jobregistry-abstract-seam"></a>

### `ctx.jobs` — `JobRegistry` (abstract seam)

Abstract background job registry. Subclass, implement the abstract members, and load the subclass as a plugin — it registers as `ctx.jobs` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Registrations outlive producer and controller fibers. Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record. Such settlements announce `cause: 'teardown'`, because a job whose owner is being destroyed has no reader left.
- Owned-job access is fenced by the owner's session id. Ids are predictable, so authorization — not secrecy — is the boundary.
- Settlement is first-wins: one terminal record, released waiters, then one round of contained event delivery, even against a late producer outcome. The `settled` event follows every released waiter and reports whether it released one (`awaited`), so a completion reporter can skip settlements a waiting caller already collected.
- A settled record stays listed until its owner's disposal, service disposal, or an explicit remove by a caller that collected the terminal state itself and never handed the id out.
- start refuses work while no attached job controller serves the spec's owner, so a producer cannot start work that owner cannot collect or stop. One registry serves every composition in the process, so this question — and event delivery under `{ owners: 'scope' }` — is owner-relative rather than process-wide: registrations made from an unscoped context serve every owner, and registrations made under an agent composition's scope serve exactly the agents composed under it.
- Every job owns one output ring. Pull sources named by the spec are pumped by the registry and drained once more before settlement; pushed appends land whole. The model's consuming cursor and observers' absolute offsets read the same bytes and never disturb each other.
- Ring retention is bounded. Appends past the live cap drop the oldest retained bytes; a reader below the retained window gets a lossy read, never an error. Settlement trims retention to the settled cap and ends the stream; the ring has no separate lifecycle.

```ts cordis-catalog
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
```

Types: [SessionId](core.md)

Source: [`packages/jobs/jobs/src/index.ts`](../../packages/jobs/jobs/src/index.ts)
<!-- END GENERATED cordis-surface -->
