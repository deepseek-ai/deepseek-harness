# Agent Note: Historical Session reads prepare before write publication

Status: implemented

English | [中文](2026-09-05-read-only-session-migration-preparation.zh.md)

## Problem

The stateful Stage pipeline makes historical Decode and migration bounded and fast, but a serial persistence open still performs encode, sync, Worker verification, publication, and committed reopen before returning either handle kind. A read-only consumer therefore waits for about 2.2 seconds of work that it does not need and mutates storage merely to display history.

### Serial readiness cost

- History pagination, projection preparation, export, and the opening `session.follow` snapshot need only the validated current logical artifact.
- A historical read open nevertheless creates and syncs a temporary v2 generation, starts a full verification Worker, rechecks the source, publishes v2, and reopens the target.
- The migration result already exists in memory before encode, but the serial API returns only the committed physical snapshot. Persistence must Decode current bytes again to reconstruct the same logical events.
- `session.follow` cannot deliver its opening snapshot until publication completes, even though Agent resume is the first operation that requires append access.
- Read-only storage cannot serve a logically valid historical Session because read open requires generation publication.

### A naive split would break lifecycle guarantees

- Returning a write handle before verification would route append into an unpublished temporary file and create a second durability state for accepted events.
- Starting publication automatically after every read would require backend ownership for task failure, shutdown, cleanup, and a later writer joining work it did not request.
- A shared preparation cannot inherit the first caller's AbortSignal. One cancelled reader must not terminate work still awaited by another.
- A read handle must initially serve prepared memory but later observe a current file and its appended tail after another caller publishes.
- Once readers have observed one prepared artifact, source drift cannot silently rerun migration and substitute a different logical history.

## Decision

The JSONL backend separates logical preparation from durable publication. Read open waits only for preparation. Write open reuses a matching preparation and waits for publication before returning a writable handle.

### Prepared generation API

```text
interface PreparedJsonlMigration {
  readonly sourceIdentity: JsonlPhysicalIdentity
  readonly artifact: SessionFormatArtifact
  publish(): Promise<JsonlPhysicalIdentity>
}
```

`prepareJsonlMigration()` reads one stable historical revision, runs the complete Stage chain once, and returns the current artifact without encoding or writing. `publish()` is idempotent: concurrent and later calls share one terminal Promise, including its rejection, and cannot encode the same prepared artifact twice.

`publish()` streams current records into an exclusively created same-directory temporary file, syncs it, awaits the bounded Worker verifier, compares the source identity captured by preparation, and publishes the canonical path without overwrite. The successful publisher reuses the prepared logical artifact instead of decoding its target. A losing publisher verifies that the winner begins with the exact staged migration prefix; append tail validation remains a current-reader responsibility.

Publication runs to settlement after invocation and is not cancelled midway by the write caller. Write open checks its caller signal before and after publication, so an abort can reject the open after the successor commits without leaking the write lease. A source identity change throws `JsonlGenerationSourceChangedError`, removes the temporary file, and does not repeat Decode or migration.

### Preparation ownership and cancellation

The persistence backend keeps one in-flight entry per Session id, selected source path, and stat-derived revision:

```text
interface MigrationPreparation {
  sourcePath: string
  sourceRevision: SessionPersistenceRevision
  controller: AbortController
  promise: Promise<PreparedStoredLog>
  settled: boolean
  waiters: number
}
```

A new read or write open joins the existing entry only when its source path and revision still match. `waitWithAbort()` races each caller's AbortSignal against the shared Promise without forwarding that signal to shared work. The backend-owned controller is aborted only when the last waiter leaves while preparation is still running. The cancellation test pauses the physical read and observes two registered waiters before aborting one caller; an event-loop yield alone cannot establish admission after asynchronous path and revision lookup.

Completed results enter the existing bounded `coldLogMemo`. The `StoredLog` discriminant separates published current state from `PreparedStoredLog`, whose `publication` field binds current logical events to their matching publication operation. A query followed by Agent resume therefore reuses the same Decode and migration result. The in-flight map owns only running work; it is not a second completed-result cache.

`SessionHandle.read()` reports whether its event values are detached or shared-frozen. The JSONL backend deep-freezes each decoded event graph once before memoization and creates the `shared-frozen` result there; later reads and slices preserve that producer-established state even when the slice is empty. `readColdSessionLog()` combines those values with locally owned interrupted-turn closers and passes the `eventState` through `SessionObservationReader`; `Session.fromRestore()` validates and adopts the seed without copying or freezing. Ordinary create and fork seeds keep their defensive snapshot path.

Read-only restoration validates the event and settlement fields required by Session runtime behavior but does not expand every embedded Assistant stream. The publication Worker retains complete stream replay and checks content, usage, and replay-state agreement before a migrated successor is committed. Existing current-v2 files rely on their writer; consumers that expand a compact stream validate its records when they read it.

### Read handle transition

A read open adopts a handle with prepared events in `state.primed` while no current generation exists. Each later `read()` resolves the current path:

```text
if current generation is absent:
  return slice of primed events
else:
  clear primed events
  read current generation and enforce non-shrinking history
```

`resolveCurrentLog()` may therefore return `undefined` for an existing historical Session: it answers whether a current canonical file exists, not whether the Session can be read. Public `stat` and `list` continue to discover the historical header.

### Write-open publication

Write open acquires the process-local claim and kernel-backed cross-process lease before re-resolving the selected generation. If it remains historical, it obtains or reuses the prepared `StoredLog` and awaits `publish()`. Only then does it return a write handle primed with the prepared events.

```text
write open
  → claim process-local ownership
  → acquire SessionWriteLease
  → re-resolve generation
  → join or create preparation
  → encode + sync temp
  → Worker verify
  → source identity check
  → no-overwrite publish
  → return writable handle
```

No external caller can append before the handle exists. `append`, `flush`, and `close` therefore retain their ordinary current-generation behavior and never need a “publishing” branch. Service `flush()` continues to flush only already adopted writers; it does not turn a read-only preparation into a write.

### Follow and Agent promotion

`session.follow` opens history through the read path, restores the Session and projections, emits the opening snapshot, and then starts Agent promotion. Agent resume uses write open, so it waits for publication before the Agent accepts a new turn. History visibility and write readiness are separate timing points without introducing an unpublished append state.

## Problem-to-solution mapping

| Serial-flow problem | Implemented mechanism | Guarantee |
|---|---|---|
| Read-only callers wait for encode and verify | Read open returns prepared events | First content waits only for Decode and migration |
| Concurrent historical opens repeat work | Session/source-revision keyed single-flight | One migration per selected revision |
| First caller owns shared cancellation | Caller-local `waitWithAbort()` plus backend controller | One cancellation does not kill other waiters |
| Preparation is lost between query and resume | `PreparedStoredLog.publication` in bounded memo | Write open reuses the same artifact |
| No current path exists for a read handle | Primed in-memory read | Historical data is readable before publication |
| Read handle must observe later append | Re-resolve and switch from primed data to current file | Existing handles converge after publication |
| Append before verification is unsafe | Publish inside write open before returning the handle | Returned writer is immediately durable-ready |
| Automatic background publication has no owner | Only write open invokes `publish()` | No orphan write task from read-only access |
| Source changes after readers saw the artifact | Fail publication without rerunning migration | Exposed logical history is never silently replaced |

## Verification

The benchmark uses the same 116,228,655-byte v0 Zstandard Session as the Stage decision. The first table compares every relevant implementation; the detailed scheduling comparison then holds the Codec/Stage chain constant between #3585 and preparation-first scheduling.

### First opening of historical data

| Implementation | Session restored | CPU | Peak RSS | Retained heap | Result |
|---|---:|---:|---:|---:|---|
| Original high-performance v0 reader | 4.594s | 6.048s | 2.720GB | 2.016GB | Reads about 9.14 million v0 events without migration |
| Master whole-artifact v0-to-v2 migration | >72.8s | — | Decode stage reached at least 7.219GB | — | OOM before returning a handle |
| #3585 streaming migration with serial publication | 6.241s | 8.493s | 2.107GB | 477MB | Produces and publishes a 72,784-event v2 Session |
| #3586 preparation-first scheduling | 2.954s | — | 1.026GB | 463MB | Produces the same v2 Session and defers publication until write open |

Preparation-first restoration is 53% faster than #3585 and 36% faster than the original high-performance reader even though it also migrates the artifact to v2.

### Scheduling observation points

| User-visible point | Serial publication | Preparation-first | Change |
|---|---:|---:|---:|
| Read open plus Session restoration | 6.241s | 2.954s | -53% |
| `session.follow` opening snapshot | 7.587s | 2.912s | -62% |
| Agent receives writable Session | 6.246s | 5.161s | -17% |
| Reopen an already-current v2 Session | 1.284s | 0.964s | -25% |
| Follow opening-snapshot peak RSS | 2.353GB | 1.059GB | -55% |

Preparation spends about 2.61 seconds in Decode and migration. Deferred publication takes about 2.56 seconds: 0.83 seconds for encode/write/sync, 1.72 seconds for strict Worker verification, and about 0.005 seconds for source check and atomic publication. A read-only request performs none of that publication work.

The prepared artifact and Session restoration peak near 1.03 GB RSS. Preparation and Worker verification together peak near 2.19 GB because the parent retains the logical artifact while the Worker independently validates the physical generation.

Tests cover shared-waiter cancellation, all-waiters cancellation, memo handoff, read-handle switching, source drift, winner collision, publication idempotence, write-open ordering, Worker failure, and the plain-Node bundled Worker entry.

## Consequences

Read-only body access does not publish a generation. The first writer pays publication once before append. A configured JSONL root must still be readable and structurally valid, but historical body migration itself does not require a successor write.

The bounded memo retains one migrated event array to bridge read and write opens. This is intentional: avoiding that retained artifact would require a second Decode and migration or would prevent early read availability.

Publication failure rejects Agent resume and other write opens but does not invalidate read results already delivered from the unchanged historical source. Source drift is terminal for that write attempt rather than a trigger to recompute hidden state.

The backend still has a broader pre-existing lifecycle gap: dispose does not own every `create()` or `open()` operation that has not yet returned a handle. This decision does not add migration-specific tracking to `flush()` or solve that general pending-operation problem.

## Alternatives considered

- **Keep serial publication for every open** — is the simplest physical state model but adds about 2.2 seconds to read-only first content and requires writable storage.
- **Publish automatically in the background after read** — needs backend task ownership, shutdown quiescence, error reporting, and writer joining even when no caller requested a write.
- **Return a writer before verification** — requires append to an unpublished stage and creates an additional durability and failure state for accepted events.
- **Give each caller an independent preparation** — repeats the dominant Decode and migration work and multiplies peak memory under concurrent list/follow/resume operations.
- **Let the first caller's signal cancel shared work** — makes later callers depend on unrelated cancellation timing.
- **Rerun migration after source drift** — can replace history already shown to readers and makes one logical operation process the same large file more than once.
- **Always keep read handles on primed memory** — prevents an existing handle from seeing later append and diverges from ordinary persistence refresh behavior.
