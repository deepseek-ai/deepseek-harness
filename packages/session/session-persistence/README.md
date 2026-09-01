---
description: "The durable session-storage seam for users and maintainers choosing a persistence backend, resuming sessions, or building a backend against the shared service contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence` stores a session's event log durably, reloads it on resume, and lists stored sessions through the backend-neutral `ctx.sessionPersistence` service. The persisted unit is the existing `SessionEvent` log — there is no parallel stored message type — and non-replayable metadata (format version, working directory, lineage, seed boundary) travels separately as `SessionHeader`. A backend owns its storage, while the service owns append-only logs, contiguous sequence numbers, crash recovery that preserves an interrupted turn instead of truncating it, and durable writes that resolve only after the batch is safe. The shipped JSONL provider implements this service with one artifact per Session; third-party providers may implement the same contract without changing the loop or model.

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

Mount one persistence backend to make sessions durable. The backend registers itself as `ctx.sessionPersistence`; nothing else in the composition changes — the loop, resume, and replay all call the same service.

### Choosing a backend

The seam ships the [JSONL](../session-persistence-jsonl/README.md) backend. It stores one append-only `.jsonl.zstd` artifact per Session and returns its absolute path from `locate(meta)`. A third-party backend may implement the service directly; the [backend contract](#understand-the-implementation) below is what it must honor.

### What the service provides

With a backend mounted, you can store a session's events durably, reload the stored log, and list what is stored:

```text
await ctx.sessionPersistence.create(meta)                  // register a session
await ctx.sessionPersistence.ensureMaterialized(session)   // persist an empty resumable session
await ctx.sessionPersistence.append(id, events)            // durably persist a batch
const { meta, events } = await ctx.sessionPersistence.load(id)   // reload on resume
const headers = await ctx.sessionPersistence.list()        // every stored session
```

`append` resolves only after the batch is durable, so a resolved write survives an OS crash or power loss. Ordinary `create` remains lazy; a lifecycle frontend calls `ensureMaterialized` only when an empty session must itself appear in durable listing without inventing an event. `load` returns an immutable balanced log and commits any needed crash recovery; `inspect` reads the same view without committing recovery. Consumers that resume from a watermark can read only the events at or past a sequence number, and a session's artifact location (`locate`) resolves without filesystem I/O.

### Resuming and crash recovery

Resume is `load` plus session preparation: the stored log comes back with its header lineage intact, so a resumed agent sees the same history and composition. A session that crashed mid-turn reloads with its interrupted final turn preserved and balanced: `load` appends synthetic `tool/result` and `turn/end {interrupted}` closers for unanswered calls instead of dropping the events — a single turn can be large, and those events were durably written before the crash. Only a never-fully-written torn tail fragment is discarded.

### Failures and recovery

A stored log the current build cannot faithfully interpret is refused with a direction-aware error, never misread. `SESSION_FORMAT_VERSION` remains v0 and this build provides no format-migration path; a newer version instructs the operator to upgrade the harness. The decoder accepts only the bounded same-version record variants named below. An event type unknown to this build refuses unless its envelope marks it `ignorable`, and committed-prefix corruption rejects as `SessionPersistenceCorruptionError`. A `load` on an id still bound to a live session first flushes its snapshot and rejects while its turn is open; a cold load applies recovery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the seam realizes durable storage and how backends plug in; the observable contract is covered in [Use this package](#use-this-package) and the generated [Cordis API](../../../docs/subsystems/persistence.md#cordis-surface).

### Design concept

The package is the Service Definition of a capability seam with two halves. The abstract `SessionPersistence` service is the public contract; a `PersistenceCoordinator` provides backend-neutral orchestration for buffering, serialization, materialization, repair, adoption, and quiescent disposal. The JSONL provider implements the small durable primitives for stored reads, append, repair, and listing; a third-party provider may reuse the same coordinator or implement the service directly.

### The invariants every backend honors

- **Append-only; a crashed turn is closed, not truncated.** Flushed events are never rewritten; `load` preserves an interrupted final turn and durably appends synthetic closers.
- **Contiguous `seq`.** A gap in the middle of the log rejects; `append`'s first `seq` must equal the stored next-seq.
- **Lossless JSON data.** Batches pass the shared one-pass lossless-JSON boundary; non-serializable payloads reject at the append site.
- **Durability.** `append` resolves only once the batch is durable.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `SessionPersistence` service and re-exported metadata types |
| [`src/coordinator.ts`](src/coordinator.ts) | Shared write orchestration: batching, serialization, repair, adoption, disposal, format refusal |
| [`src/write-behind.ts`](src/write-behind.ts) | The per-session bounded write controller and flush barrier |
| [`src/preparations.ts`](src/preparations.ts) | Bounded retention of unpublished Session preparations for resume reuse |
| [`src/revision.ts`](src/revision.ts) | The branded opaque revision token |
| — | No runtime invariant companion is published; persistence correctness requires backend round-trip and crash-tail tests; this package exposes no continuously observable in-process relation. |

### The write path at a glance

Each `session/event` copies the event into its session's controller. The first pending event starts a fixed batching window; later events join without resetting its deadline. Expiry starts one durable append; events admitted during that write form a separately bounded follow-up batch. `session/flush` cancels the wait and drains through quiescence, so the loop uses it as the ordering and error-observation checkpoint before the next turn. A rejected background write retains its events and pauses automatic retry; a new event starts a fresh window, while explicit flush or backend teardown retries immediately.

### Stored-record compatibility

Backend reads normalize only the explicitly supported v0 record variants before validating current records. The coordinator uses the same normalized view for `load`, `inspect`, `readFrom`, ownerless-state claims, and HMR adoption. Reads do not rewrite stored records, and later appends use current v0. The [pre-identity message](../../../.agents/notes/implemented/bug-fix/2026-07-28-load-pre-identity-session-messages.md) and [pre-react-loop session](../../../.agents/notes/implemented/bug-fix/2026-08-04-load-pre-react-loop-sessions.md) notes own these bounded exceptions; they are not a general format-migration promise.

</details>
-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared durability model to the shipped backends and the decision evidence.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the full service contract, flush checkpoint, crash recovery, and generated Cordis API.
- [JSONL persistence backend](../session-persistence-jsonl/README.md) — the shipped per-session-file backend.
- [Session checkpoint policy](../session-checkpoint-policy/README.md) — the plugin that flushes through this service at semantic boundaries.
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

- **No deletion or retention API** — pruning stored sessions is out-of-band backend maintenance.
- **`list()` is unpaginated and unfiltered** — it returns every stored session's header; fine for local stores, unindexed at scale.
- **Synthetic closers are the only crash story** — a backend must synthesize `tool/result`/`step/end`/`turn/end` closers on load; there is no partial-turn resume that continues an interrupted turn instead of closing it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
