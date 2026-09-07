# Agent Note: Lifecycle-bound message feedback sidecar

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-message-feedback-sidecar.zh.md)

## Problem

The existing `/feedback` command records an immutable Session-level `feedback/record` event. That event can release a pending telemetry prefix under `FEEDBACK_ONLY`, so it is the wrong authority for an editable positive/negative rating and optional note attached to one assistant message. Message feedback needs independent update and delete semantics without entering the canonical Session log, changing a projection, reaching model context, or implicitly consenting to telemetry.

A sidecar keyed only by `SessionId` can outlive the log lifecycle it describes when an id is recreated with a different header identity. A Session-wide revision also makes unrelated message edits conflict, while plain storage-domain read/put has no cross-process compare-and-swap. Session disposal is only live-store detach, not durable deletion, and the current Session persistence seam exposes no deletion operation that could own a truthful cascade.

## Decision

`@deepseek-ai/dsh-message-feedback` owns the `ctx.messageFeedback` service and stores message feedback as one storage-domain sidecar row per Session. The sidecar is neither Session-log content nor a Session projection. It emits no `feedback/record` event and performs no telemetry handoff; the command-feedback and message-feedback contracts remain independent.

Every usable row is bound to the inspected Session header identity `{createdAt, cwd}`, not merely its `SessionId`. A lifecycle mismatch is treated as absence: `list` returns no items, and `put` may replace the stale row with one bound to the current identity. An id reused with a different header identity therefore cannot inherit stale feedback. A fork receives its own Session identity and no sidecar copy: even when the fork seed contains the same assistant messages, feedback remains attached to the Session in which the human recorded it.

`put` accepts a target only when the observed log — a live owner's in-memory events, else the durable log through a persistence read handle — contains a non-empty, append-origin `assistant/message` with that `MessageId`. Replacement-origin messages, empty usage-only assistant records, and non-assistant targets are rejected. Observation is cold-safe: it neither publishes or resumes an Agent nor commits cold-log repair merely to validate feedback. A cold `stat()` preflight classifies definite absence; a read failure for a catalogued Session remains an infrastructure failure. A request in the narrow live-detach-to-header-materialization interval can therefore return `session-not-found`, and the caller retries after retirement materialization.

Before `put` commits a sidecar row, it puts the target log behind a durability barrier. A matching live Session passes through the canonical `ctx.sessions.flush` checkpoint, then both live and cold paths are physically re-read from sequence zero through a fresh persistence read handle. The resulting observation's header identity and target are checked again. A missing flush participant, changed identity, vanished target, or physical-read failure prevents the sidecar write, so a committed feedback item never precedes the durable assistant message it references.

Each message item carries its own opaque version plus Host-assigned `createdAt` and `updatedAt` timestamps. `put` compares the caller's `ifVersion` only with the addressed item, so editing one message does not invalidate another. The comparison is strict even when the desired value already matches, preventing a stale request from crossing an ABA value cycle; a conflict returns the authoritative current item so callers can reconcile without a second read. A matching-version no-op preserves the version and timestamps, while a material update preserves `createdAt`, replaces the version, and keeps `updatedAt` from moving backward. An already-absent delete is likewise successful. Versions are tokens for equality, not counters callers may order or synthesize.

A per-Session mutation queue encloses lifecycle inspection, sidecar read, conflict evaluation, and whole-row write. This makes one service instance's mutations serial and preserves the per-message compare-and-swap contract inside one Host process. Plugin disposal closes admission, drains accepted queue work, and then closes the storage domain. The underlying storage-domain API provides no cross-process conditional write, so the implementation claims no cross-process linearizability or lost-update protection.

`maxNoteBytes` is a required deployment choice and bounds the UTF-8 byte length of an optional note; the Web Host bundle sets it explicitly to `8192`. The package publishes the Host `messageFeedback.list`, `messageFeedback.put`, and `messageFeedback.delete` contract directly through `TypertRemoteService` and `@Remote`. Client Remote aggregate mounting and UI remain separately owned and deferred; their later adapter stays a thin consumer of this Host contract.

The service performs no fake deletion cascade. `session/disposed` and `host/session-removed` describe detach from live ownership, not durable Session deletion, and Session persistence currently has no deletion API. Sidecar rows can therefore remain after out-of-band log removal; a different `{createdAt, cwd}` prevents such an orphan from becoming feedback for a later Session that reuses the id.

## Alternatives considered

**Append edits to the Session log and derive a projection.** Rejected because editable UI metadata would become canonical conversation-adjacent history, forks would replay and inherit it, deletion would require tombstones, and reusing `feedback/record` would silently couple a message rating to telemetry consent.

**Key feedback globally by `MessageId`, copy it on fork, or use one Session revision.** Rejected because message ids are meaningful only within a Session lifecycle, forked conversations need independent human judgments, and unrelated message mutations must not create false conflicts.

**Extend `KvTable` with cross-process compare-and-swap in this change.** Rejected because the shipped storage-domain backends expose no common conditional-write primitive. A process-local queue matches the supported one-Host topology; a real multi-process guarantee requires a backend-level atomic contract and is separate work.

**Delete feedback on Session disposal.** Rejected because disposal includes ordinary detach and rollback paths. Treating it as durable deletion would lose feedback while the Session log still exists; cleanup waits for a real Session deletion authority.

## Consequences

Message feedback is locally durable and independently editable without changing model-visible history or telemetry behavior. Concurrent callers in one Host receive per-message conflict detection and retry-safe outcomes, while deployments with multiple writers to the same storage root remain unsupported. A differing header identity treats a stale row as absent but does not reclaim it; a cloned log that retains the same `{createdAt, cwd}` is indistinguishable by this contract. The Host Remote contract is available now; client assembly and UI can remain thin consumers rather than taking ownership of persistence or concurrency semantics.
