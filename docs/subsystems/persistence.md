# Session Persistence

English | [中文](persistence.zh.md)

The **durability seam** for the event log. [session.md](session.md) describes the in-memory `Session` — the append-only `SessionEvent` log that is the source of truth. This page describes how that log is made durable: the abstract `SessionPersistence` service, its provider model and shipped JSONL backend, the flush checkpoint, crash recovery, and the metadata header that travels alongside the log. The event vocabulary the log carries is enumerated, member by member, in the generated [persistence log event catalog](../persistence-catalog.md).

The seam is a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): one abstract service ([dsh-session-persistence](../../packages/session/session-persistence), `ctx.sessionPersistence`) exposing `create`/`open`/`stat`/`list` over the existing `SessionEvent` — **no parallel persisted event type** — where `create` and `open` return a per-session `SessionHandle` (`read`/`append`/`flush`/`close`) that carries all log access and single-writer ownership. The repository ships [dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl) as its provider; out-of-tree providers may implement the same service contract. See the [handle-based persistence Agent Note](../../.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md) and the [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md).

## `SessionHandle` — one open channel onto a stored session

Every log read and write flows through a handle, never through id-addressed service methods: the handle is the single door the cross-process write lease guards. A read returns a caller-owned outer slice and the producer-established aliasing state of its event values. One handle type serves both accesses — a mutation on a `read` handle is a runtime `SessionReadOnlyError` rather than a typed split — and in-process single-writer ownership makes a second `open(id, 'write')` reject with `SessionAlreadyOwnedError` while an owner is active.

```ts type-equiv
/** One persistence event slice returned by {@link SessionHandle.read}. */
interface SessionHandleReadResult {
  /**
   * Whether event values are exclusively owned or shared only after deep
   * freezing. Slicing preserves the producer's state even when no events remain.
   */
  readonly eventState: SessionSeedEventState
  /** Event values in a caller-owned outer array. */
  readonly events: readonly SessionEvent[]
}
```

```ts type-equiv
/**
 * One open channel onto a stored session. A handle is single-owner state, not
 * a shared service: `read` never backtracks below what this handle already
 * observed, a `write` handle reads its own successful appends, and `close()`
 * is the one teardown (idempotent, uncancellable; `Symbol.asyncDispose`
 * delegates to it). Every operation on a closed handle rejects with
 * `SessionHandleClosedError`.
 *
 * Freshness across handles: once an `append` or `flush` resolves on a write
 * handle, every read STARTED afterwards on the same backend instance — on any
 * handle, or through `stat`/`list` — observes at least that prefix.
 * Reads concurrent with a mutation carry no ordering promise beyond the valid
 * contiguous prefix.
 */
interface SessionHandle extends AsyncDisposable {
  /** The stored session this handle addresses. */
  readonly id: SessionId
  /** The immutable stored header, fixed at `create`/`open`. */
  readonly header: SessionHeader
  /**
   * Exact fork-inherited prefix length stored with the log; `0` when
   * `header.isSeeded` is false. Storage metadata paired with the header for
   * every body read, never part of the replayable event log.
   */
  readonly inheritedEventCount: SessionLogOffset
  /** Whether this handle may mutate the log. */
  readonly access: SessionAccess

  /**
   * Read a slice of the valid contiguous logical log. The slice is a legal log
   * prefix segment: a torn physical tail is never returned, and repeated reads
   * on this handle never observe an older state than a prior read.
   * @param offset - first logical event seq to include; defaults to `0`.
   * @param length - maximum number of events to return; defaults to the rest
   *   of the log. An offset at or past the end returns an empty list.
   * @param options - optional cancellation.
   * @returns the caller-owned outer slice plus the ownership state of its event values.
   */
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>

  /**
   * Append a contiguous batch continuing the current logical end. The first
   * event's `seq` MUST equal the stored next-seq; committed events are never
   * rewritten. Persistence is best-effort: on resolution the batch is
   * accepted, ordered, and visible to reads on this backend instance, but
   * only a resolved {@link flush} promises it survives a crash — a backend
   * may buffer or batch physical writes behind append. Rejects with
   * `SessionReadOnlyError` on a read handle and `SessionOwnershipLostError`
   * when write ownership is gone.
   * @param events - the contiguous batch, in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>

  /**
   * The durability barrier — the one operation that promises storage: on
   * resolution every acknowledged append is durable and the session is
   * materialized for other processes; an empty created session becomes
   * durably listable here. Callers that must survive a crash flush; a backend
   * whose `append` already persists on resolution treats this as
   * materialize-if-needed. Rejects with `SessionReadOnlyError` on a read
   * handle.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void>

  /**
   * Release the handle: a read handle frees local resources; a write handle
   * completes pending durability and releases write ownership. Idempotent,
   * asynchronous, and deliberately not cancellable.
   */
  close(): Promise<void>
}
```

A created session is observable in this process from the moment `create` resolves, while a backend may defer physical materialization (a pure optimization) until the first `append` or `flush`; other processes see only materialized sessions, and a session that never materialized before a crash never existed.

## The flush checkpoint

`session/event` is a *synchronous* notification; the mounted backend routes it by session id into the active write handle's bounded write-behind window without blocking the producer (the backend installs these listeners once, because persistence already enforces one active write handle per id). The first pending event starts a fixed internal batching window, and later events join without resetting its deadline. Expiry starts one durable `append` through the session's write handle; events admitted during that write receive their own deadline and form a follow-up batch. `session/flush` cancels the wait and drains through quiescence, so the loop still uses it as the ordering and error-observation checkpoint before claiming the next ordinary turn. A rejected background write retains its events in order, pauses the automatic path, and is reported through the logger; the next explicit flush retries and rejects loudly to its caller. `session/disposed` performs the same final drain and closes the handle, and `close()` itself drains the routed buffer through the still-open storage, so backend teardown's close sweep loses nothing. The window bounds only intentional batching wait, not event-loop scheduling or backend durability latency.

## Crash recovery preserves an interrupted turn

A log crashed mid-turn ends with an open `turn/start` and no `turn/end`. Persistence does **not** truncate or repair it — a single turn can be huge in a long-horizon task (many steps, large tool output), and those events were durably appended before the crash. It returns the physically valid contiguous log; only the incomplete fragment of a torn physical tail, belonging to an append that never resolved, is discarded — complete records recovered from it (the JSONL backend partially decodes a torn Zstandard frame) are durably rewritten by the write path before the handle's first new append. Repair is the reader's job: resume (agent-loop) reads the stored log through its write handle, computes `interruptedTurnClosers` — missing tool errors, any open `step/end`, and a synthetic `turn/end { reason: { kind: 'interrupted' } }` — and appends them through the same handle as an ordinary batch before publishing the Session. `interrupted` is the one `TurnEndReason` no loop emits (see [session.md](session.md#why-a-turn-ended-turnendreasonmap)).

Repair therefore writes only under write ownership: a live session's write handle is held by its lifecycle owner, so a concurrent `open(id, 'write')` rejects with `SessionAlreadyOwnedError` instead of racing repair against a live turn. Read-only observers (session-query) balance an interrupted cold log with the same closers in memory only, writing nothing back.

Read-only observation is `open(id, 'read')`: the handle serves validated contiguous prefix slices, never a torn tail, and repeated reads on one handle never observe an older state than a prior read. There is no persistence-side prepared-Session cache: session-query owns its cold-read cache, keying one balanced cold Session per id on the `stat().revision` change token and re-reading only when the token changes. The [handle-based persistence Agent Note](../../.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md) owns this lifecycle; the archived [Session preparation record](../../.agents/notes/archived/architecture/2026-08-05-session-preparation.md) documents the original publication-boundary `SessionPreparation` decision.

## `SessionLocation` — refusal-diagnostics artifact target

`SessionLocation` is not a consumer-facing query: log access goes through a session handle's `read`. It survives only as refusal diagnostics, letting a `SessionFormatUnsupportedError` name the raw log a build refused to interpret. JSONL supplies the absolute transcript path inside its project/session directory; a backend without one artifact per session supplies nothing.

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. Carried only by
 * refusal diagnostics ({@link SessionFormatUnsupportedError}) so a user can
 * find the raw log a build refused to interpret; it is not a consumer-facing
 * query — log access goes through a session handle's `read`.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

<a id="sessionheader--metadata-beside-the-log"></a>

## `SessionHeader` — metadata beside the log

Per-session metadata travels **separately** from the event log: the header carries format version, cwd, and the `isSeeded` lineage bit, while body-bearing storage values carry the exact inherited cut beside it. Neither belongs to `SessionEventMap` or reaches `deriveMessages()`. The logical header is attached through `session.header`; the Session exposes its cut as `inheritedEventCount`.

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * Current logical format version, stamped from {@link SESSION_FORMAT_VERSION}.
   * Historical physical headers are translated before entering this interface.
   */
  readonly version: typeof SESSION_FORMAT_VERSION
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * Whether this Session contains a fork-inherited event prefix. The exact prefix
   * length is Session state rather than ordinary header metadata.
   */
  readonly isSeeded: boolean
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string
}
```

## Format refusal — logs a build cannot faithfully read

A backend refuses a log it cannot faithfully interpret with `SessionFormatUnsupportedError`, distinct from `SessionPersistenceCorruptionError` because nothing is damaged. `stat` and `list` classify the highest canonical generation and translate a supported historical header without reading or mutating its body. Historical `open` calls share one per-session migration preparation before returning current logical values and leave every source path, byte, and inode unchanged. The JSONL provider returns a read handle from that in-memory result without publishing; a write open holds its single-writer claim and file lease while it reuses the preparation, exclusively publishes the final current generation, and only then returns the writable handle. A future highest generation refuses even when an older readable generation remains. Current v2 restoration retains installed extensions and unknown events carrying `ignorable: true`; historical v0/v1 migration refuses an unknown type even when marked ignorable. The message appends the selected raw log path when the backend keeps one artifact per session. An out-of-tree backend must enforce equivalent current-only handle values and direction-aware refusals at its physical-format entry. The [released-format migration decision](../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) owns the chain and immutable-publication rules.

## `CreateSessionOptions` — seeding and metadata

Creating a `Session` through the store takes a `seed` (initial replay or fork history), an optional exact `inheritedEventCount`, and `meta` (the storage-level fields the store folds into a `SessionHeader`). The store fills in `version`/`id` and defaults `createdAt`; the caller may supply the validated absolute `cwd`, `parentSession` lineage, `isSeeded` lineage bit, optional coarse `origin`, `delegationDepth`, `agentPreset`, and an existing `createdAt`. A seeded creation requires an explicit seed equal to its inherited prefix and an exact cut; the constructor appends the child-owned tagged end-seed marker at that cut before setup adds child-owned events. `origin: 'subagent'` lets product navigation hide duplicate child rows; it does not prove that a descriptor is valid or that the child can resume.

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Exact fork-inherited prefix length when `meta.isSeeded` is true. In v2 the
   * constructor seed is exactly this inherited prefix; the constructor
   * appends the child-owned tagged marker at the cut.
   */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Storage metadata read once before publication. `isSeeded` marks fork
   * lineage; supplying replay history alone does not make it inherited.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}
```

Replay/fork is therefore `ctx.agents.create({ sessionId, seed, meta })` — a fork additionally supplies `inheritedEventCount` with `meta.isSeeded: true`, and only agent-loop-published sessions persist, and the loop stores the seed through the new session's write handle before publication; resuming a *persisted* session into a live agent is `ctx.agents.resume({ resumeSessionId })`.

## Preparation and restoration ownership

`SessionStore.prepare()` accepts ordinary creation options or an adoptable seed through `RestoredSessionOptions`. Its `eventState` says whether event values are independently owned or shared only after deep freezing; the producer establishes that state, and slicing does not infer a different state from result length. Restoration validates and adopts those values without another copy or freeze pass. `SessionPreparation` then owns the exact unpublished Session until publication or rollback; disposal is synchronous and idempotent. agent-loop's resume reads this result through the session's write handle and appends independently owned `interruptedTurnClosers` before preparation.

```ts type-equiv
/**
 * Aliasing state of an adoptable Session seed. `shared-frozen` permits deeply
 * frozen aliases plus independently owned unfrozen values in the same seed.
 */
type SessionSeedEventState = 'detached' | 'shared-frozen'
```

```ts type-equiv
/**
 * Adoptable storage values transferred to {@link SessionStore.prepare}
 * without another copy or freeze pass.
 */
interface RestoredSessionOptions {
  /** Events that are independently owned or already deeply frozen. */
  readonly seed: SessionEvent[]
  /** Independently owned storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader
  /** Exact number of fork-inherited leading events decoded from storage. */
  readonly inheritedEventCount: SessionLogOffset
  /** Aliasing state carried from the operation that produced the seed. */
  readonly eventState: SessionSeedEventState
}
```

```ts type-equiv
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly eventState?: undefined })
  | RestoredSessionOptions
```

```ts type-equiv
/** Options for a preparation whose provider retains unpublished state. */
interface SessionPreparationOptions {
  /** Release provider-owned state when the Session was not published. */
  readonly release?: () => void
}
```

```ts public-api
/**
 * One exact unpublished Session and the provider state that keeps it usable.
 * Disposal is synchronous and idempotent. Providers decide whether release
 * returns the Session to a cache or discards it; publication may consume that
 * state before disposal, making the callback a no-op.
 */
declare class SessionPreparation implements Disposable {
  /** The exact Session to use for setup and publication. */
  readonly session: Session;
  /**
   * Wrap an unpublished Session in one preparation lifetime.
   * @param session - exact unpublished Session.
   * @param options - optional provider release behavior.
   * @returns a preparation disposed after publication or rollback.
   */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation;
  /** Release provider state once when this preparation leaves its caller. */
  [Symbol.dispose](): void;
}
```

## Lightweight source revisions

Consumers of derived read models compare a cheap opaque revision before loading a full event log. The revision is a per-backend-instance change token from `stat`/`list`: equal revisions may be treated as an unchanged log; unequal revisions promise nothing, and write-ownership churn never changes one. session-query keys its cold-read cache on it; the token plays no part in open, read, or resume.

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
}
```

The optional `eventCount`/`sizeBytes` fields remain cheap backend observations for consumers that explicitly need them. Session listing does not use either field to open cold logs: it reads headers plus identity-checked projection-cache hints only, so a cache or Session-format upgrade never turns startup into a body scan.

## The backend

The shipped provider implements the abstract `SessionPersistence` contract (`create`/`open`/`stat`/`list`, with per-session `SessionHandle`s carrying `read`/`append`/`flush`/`close` and optional cancellation throughout) and passes the shared persistence contract suite:

- **[dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl)** — an append-only logical JSONL log per session, stored as checksummed concatenated Zstandard frames by default or raw lines by configuration, with crash-safe atomic materialization, per-batch `fsync` appends, and torn-tail truncation before the first new append. `stat`/`list` carry `sizeBytes` and a best-effort `fs.stat`-derived revision.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionpersistence--sessionpersistence-abstract-seam"></a>

### `ctx.sessionPersistence` — `SessionPersistence` (abstract seam)

Durable append-only session storage addressed through per-session handles.

Storage semantics shared by every backend: events are contiguous from seq 0 and never rewritten; a torn physical tail is never returned to a reader and is truncated by the write path before its first append; reads validate current-format records only and refuse unknown vocabulary fail-closed. `append` persists best-effort; `flush` — per handle or service-wide — is the durability barrier.

Visibility: a created session is observable through `stat`/`list`/`open` in this process from the moment `create` resolves, even while a backend defers physical materialization (a pure optimization); other processes see the session only once it materializes, and a session that never materialized before a crash never existed. `SessionHandle.flush` forces materialization.

Freshness: once an `append` or `flush` resolves, reads started afterwards on this backend instance observe at least that prefix.

```ts cordis-catalog
/**
 * Create a new stored session and take its write ownership.
 * @param header - the immutable header (id, version, cwd, lineage) to store.
 * @param options - optional cancellation.
 * @returns a `write` handle owned by the caller; close it to release ownership.
 * @throws {SessionAlreadyExistsError} when the id already exists.
 */
abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

/**
 * Open an existing stored session.
 *
 * `read` never takes ownership and works while another handle (or process)
 * holds write ownership. `write` atomically claims single-writer ownership;
 * an existing active owner rejects.
 * @param id - the stored session to open.
 * @param access - `read` or `write`.
 * @param options - optional cancellation.
 * @returns the open handle.
 * @throws {SessionPersistenceNotFoundError} when the session does not exist.
 * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
 */
abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

/**
 * Flush every active write handle owned by this service instance in one
 * durability barrier: each handle's routed live events drain durably and
 * its session materializes, exactly as that handle's own
 * `SessionHandle.flush` would. Read handles buffer nothing and are
 * untouched. A handle closed concurrently counts as flushed — close itself
 * drains durably.
 * @returns resolution once every write handle active at the call has flushed.
 * @throws {AggregateError} naming each session whose flush failed; the
 *   remaining handles still flush.
 */
abstract flush(): Promise<void>

/**
 * Observe one stored session without reading its event log or taking
 * ownership.
 *
 * The snapshot's `revision` is an opaque change token comparable only
 * against revisions from the same service instance and session id: equal
 * revisions may be treated as an unchanged log; unequal revisions promise
 * nothing. Write-ownership churn does not change a revision. It exists for
 * derived read-model caches keyed off `stat`/`list`; it plays no part in
 * open, read, or resume.
 * @param id - the stored session to observe.
 * @param options - optional cancellation.
 * @returns the snapshot, or `undefined` when the session does not exist.
 */
abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

/**
 * List every stored session visible to this process, in no promised order.
 * @param options - optional cancellation.
 * @returns one snapshot per stored session.
 */
abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>
```

Types: [SessionId](core.md)

Source: [`packages/session/session-persistence/src/index.ts`](../../packages/session/session-persistence/src/index.ts)
<!-- END GENERATED cordis-surface -->
