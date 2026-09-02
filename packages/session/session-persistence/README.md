---
description: "The durable session-storage seam for users and maintainers choosing a persistence backend, resuming sessions, or building a backend against the shared service contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence` stores a session's event log durably and addresses each stored session through one per-session handle: the backend-neutral service (`ctx.sessionPersistence`) exposes `create`/`open`/`stat`/`list`, and `create`/`open` return a `SessionHandle` that carries every log read and write plus single-writer ownership. The persisted unit is the existing `SessionEvent` log — there is no parallel stored message type — and non-replayable metadata (format version, working directory, lineage, seed boundary) travels separately as `SessionHeader`. Backends own their storage, the seam owns the semantics: append-only contiguous logs, best-effort appends behind an explicit `flush` durability barrier, a torn physical tail that never reaches a reader, fail-closed validation of stored records, and in-process exclusion of a second writer. Mount the shipped [JSONL backend](../session-persistence-jsonl/README.md) (one artifact per session) and agent-loop persists and resumes sessions without the loop or the model knowing which backend is underneath.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount one persistence backend to make sessions durable. The backend registers itself as `ctx.sessionPersistence` and routes every published session's live events into that session's active write handle; agent-loop — the production publication point for sessions — acquires each session's write handle before publication, so nothing else in the composition changes.

### Choosing a backend

The seam ships the [JSONL](../session-persistence-jsonl/README.md) backend: one append-only `.jsonl.zstd` log per session. A third-party backend may implement the service directly; the [backend contract](#understand-the-implementation) below is what it must honor.

### What the service provides

With a backend mounted, five service methods address stored sessions:

```text
const handle = await ctx.sessionPersistence.create(header)     // store a new session, take write ownership
const handle = await ctx.sessionPersistence.open(id, 'write')  // claim single-writer ownership of an existing session
const reader = await ctx.sessionPersistence.open(id, 'read')   // observe without ownership
const snap = await ctx.sessionPersistence.stat(id)             // header + revision (+ eventCount / sizeBytes) without a log read
const all = await ctx.sessionPersistence.list()                // one snapshot per visible stored session
await ctx.sessionPersistence.flush()                           // backend-wide durability barrier over every active write handle
```

Service-level `flush()` drains every active write handle's routed events and materializes its session, exactly as each handle's own `flush` would; failures aggregate per session as an `AggregateError` without abandoning the sweep, and a handle closed mid-sweep counts as flushed because close itself drains durably.

Every log read and write flows through the returned `SessionHandle`; there are no id-addressed append or load methods. `handle.read(offset?, length?)` returns validated contiguous prefix slices — never a torn tail, and repeated reads on one handle never observe an older state than a prior read; a write handle reads its own successful appends. `handle.append(events)` appends a contiguous batch whose first `seq` equals the stored next-seq; persistence is best-effort on resolution — the batch is accepted, ordered, and visible to reads on this backend instance, and only a resolved `flush` promises it survives a crash (the shipped JSONL backend happens to persist each batch immediately). `handle.flush()` is the durability barrier and also materializes an empty created session so it becomes durably listable. `handle.close()` is idempotent and uncancellable: a read handle frees local resources, a write handle completes pending durability and releases write ownership. Once an `append` or `flush` resolves, reads started afterwards on the same backend instance — on any handle, or through `stat`/`list` — observe at least that prefix.

### Ownership and visibility

`create` and `open(id, 'write')` take in-process single-writer ownership: a second write open while an owner is active rejects with `SessionAlreadyOwnedError`, `create` on an occupied id rejects with `SessionAlreadyExistsError`, and a mutation on a `read` handle rejects with `SessionReadOnlyError` — one handle type, runtime refusal. Any operation on a closed handle rejects with `SessionHandleClosedError`, and `SessionOwnershipLostError` marks a write handle whose ownership is permanently gone (close it and reopen). A created session is observable in this process from the moment `create` resolves, while the backend may defer physical materialization until the first `append` or `flush`; other processes see only materialized sessions, and a session that never materialized before a crash never existed.

### The live write path and shutdown drain

The backend owns the live write path: it installs the session listeners once and routes every published session's events by id to that session's active write handle — `session/event` copies into a bounded internal batching window, `session/flush` is the immediate durability and error-observation barrier, and `session/disposed` runs the final drain and closes the handle. A published session without an active write handle persists nothing. A background write failure retains its events in order, pauses the automatic path, and is logged; the next explicit flush retries and rejects loudly. `close()` itself drains the routed buffer through the still-open storage before releasing ownership, so backend teardown's close sweep keeps application shutdown lossless even though root-fiber disposal runs fibers' disposers concurrently.

### Resuming and crash recovery

Persistence returns the physically valid log; semantic repair belongs to the reader. A session that crashed mid-turn keeps its open final turn — a single turn can be large, and those events were durably appended before the crash; only the incomplete fragment of a never-acknowledged torn tail is discarded — complete records recovered from it are durably rewritten by the write path before the handle's first new append. Resume (agent-loop) reads the stored log through its write handle, computes `interruptedTurnClosers` — synthetic `tool/result` errors, any open `step/end`, and `turn/end {interrupted}` — and appends them through the same handle as an ordinary batch. Read-only observers (session-query) balance an interrupted cold log with the same closers in memory only.

### Failures and recovery

A stored log the current build cannot faithfully interpret is refused with a direction-aware error, never misread. `SESSION_FORMAT_VERSION` remains v0 and this build provides no format-migration path; a newer version instructs the operator to upgrade the harness. The decoder accepts only the bounded same-version record variants named below. An event type unknown to this build refuses unless its envelope marks it `ignorable`, and committed-prefix corruption rejects as `SessionPersistenceCorruptionError`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the seam realizes durable storage and how backends plug in; the observable contract is covered in [Use this package](#use-this-package) and the generated [Cordis API](../../../docs/subsystems/persistence.md#cordis-surface).

### Design concept

The package is a seam, not a backend framework: it exports the abstract `SessionPersistence` service, the `SessionHandle` contract, the stable error classes consumers catch, the pure stored-record validation helpers (`storage-contract`), and the branded revision — nothing else. Each provider owns its complete storage runtime (handle class, mutation ordering, single-writer bookkeeping, live-event routing, teardown), and two shared test suites — `runPersistenceContract` and `runLiveWritePathContract` under `tests/` — pin the observable behavior every provider must agree on. Deliberate consequence: providers may resemble each other where their storage happens to be similar, but no implementation machinery crosses the package boundary.

### The invariants every backend honors

- **Append-only, contiguous `seq`.** Committed events are never rewritten; `append`'s first `seq` must equal the stored next-seq, and a gap rejects.
- **A torn physical tail never reaches a reader.** It belongs to an append that never resolved; the write path truncates it durably before its first new append.
- **Lossless JSON data.** Batches and headers pass the shared one-pass validate-and-snapshot boundary (`materializeAppendBatch`/`materializeCreateHeader`); non-serializable payloads reject at the call site.
- **Durability.** `append` persists best-effort; `flush` — per handle or service-wide — is the barrier that promises storage and also materializes an empty session.
- **Fail-closed reads.** `validateStoredEvents` refuses unknown event vocabulary and retired pre-release shapes; `assertVersion` refuses foreign format versions.
- **Single writer per backend instance.** The provider's in-process claim is taken at `create`/`open('write')` and released at handle close.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `SessionPersistence` service and re-exported seam vocabulary |
| [`src/handle.ts`](src/handle.ts) | The `SessionHandle` contract: read/append/flush/close semantics and freshness rules |
| [`src/storage-contract.ts`](src/storage-contract.ts) | Shared validation: version gate, fail-closed vocabulary, batch materialization, contiguity |
| [`src/errors.ts`](src/errors.ts) | Stable handle/ownership failures and format refusals |
| [`src/revision.ts`](src/revision.ts) | The branded opaque revision token |
| — | No runtime invariant companion is published; persistence correctness requires backend round-trip and crash-tail tests; this package exposes no continuously observable in-process relation. |

### The write path at a glance

Each `session/event` for the writer's session copies into that handle's internal buffer. The first pending event starts a fixed batching window; later events join without resetting its deadline. Expiry drains the pending prefix through the handle's mutation chain; events admitted during a drain coalesce into the next chained batch, in order. `session/flush` cancels the wait and drains through quiescence, then runs `handle.flush()`, so the loop uses it as the ordering and error-observation checkpoint before the next turn. A rejected background drain retains its events and pauses the automatic timer; explicit flush, writer close, or backend teardown retries immediately and rejects loudly. Constructor seed events never emit `session/event`, so a seed appended through the handle before publication is never re-enqueued.

### Stored-record validation

Backend reads validate current v0 records only and never rewrite them; appends write current v0 ([rationale](../../../.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md)). Every backend runs the same `storage-contract` helpers on every read path — handle reads and write-open priming — refusing an unknown event type as `SessionFormatUnsupportedError` and a retired payload variant of a current type as `SessionPersistenceCorruptionError`, with the raw-log `SessionLocation` attached when the backend keeps one artifact per session.

</details>
-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared durability model to the shipped backends and the decision evidence.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the full service contract, handle semantics, flush checkpoint, crash recovery, and generated Cordis API.
- [Handle-based persistence Agent Note](../../../.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md) — the seam design and its ownership model.
- [JSONL persistence backend](../session-persistence-jsonl/README.md) — the shipped per-session-file backend.
- [Session checkpoint policy](../session-checkpoint-policy/README.md) — the plugin that flushes through `session/flush` at semantic boundaries.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

The seam adds no prompt or schema. Resume restores stored surface events as message history; stored request headers reconstruct earlier calls, while the new loop composes the current system prompt, tools, and session prefix for its next request. Crash repair marks an assistant request without a durable call as `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, whose text lets the model retry read-only or idempotent work but directs it to verify side effects or ask the user instead of retrying blindly.

#### Token effect

Zero tokens during ordinary persistence. Resume restores retained history cost and pays the current request envelope normally; each repaired call adds the quoted retained error text.

#### KV Cache effect

Persistence does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append without rewriting earlier history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the seam's guarantees stop. They are current package constraints, not a task backlog.

- **Write ownership is in-process only** — the provider's writer table excludes a second writer inside one backend instance; the durable cross-process lease is the planned next layer on the same handle shape, and until it lands another process must not write the same session.
- **A backend plugin reload under live sessions fails their writers loudly** — a reloaded backend cannot serve handles the old instance issued; writes fail until the sessions restart, and nothing silently re-adopts the logs.
- **Only handle-acquired sessions persist** — `ctx.sessions.create` + `session/flush` alone stores nothing; agent-loop is the production acquisition point, and tests seed storage through `create`/`append`/`close`.
- **No deletion or retention API** — pruning stored sessions is out-of-band backend maintenance.
- **`list()` is unpaginated and unfiltered** — it returns every stored session's snapshot; fine for local stores, unindexed at scale.
- **Synthetic closers are the only crash story** — resume appends `interruptedTurnClosers` through the write handle; there is no partial-turn resume that continues an interrupted turn instead of closing it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
