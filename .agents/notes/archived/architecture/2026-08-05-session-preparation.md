# Agent Note: Reusable Session preparation before publication

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-session-preparation.zh.md)

## Problem

Fresh creation and persisted resume reached the same publication boundary through different construction flows. This obscured the invariant that setup must finish against one unpublished Session before that exact Session and its Agent become visible together.

Cold history inspection and Agent resume also independently materialized the same persisted session log, which this note originally answered with a persistence-side prepared-Session cache; that half is superseded below.

## Decision

`SessionPreparation` owns one exact unpublished `Session` until publication or rollback. It is a Session lifecycle object, not an Agent lifecycle or activation object. Fresh creation wraps the result of `SessionStore.prepare()`; persisted resume reads the stored log through the session's write handle, appends `interruptedTurnClosers`, and wraps `SessionStore.prepare(id, { seed, meta, seedSource: 'persistence' })` — the restoration branch that validates and freezes the transferred graphs in place.

The Agent loop consumes both forms through one setup-and-publication pipeline: it acquires the preparation, builds the private Agent context around `preparation.session`, awaits optional setup, publishes that exact Session and Agent, and disposes the preparation on every exit. Publication transfers the live lifecycle to the existing Session and Agent stores; `SessionPreparation` itself owns no Agent behavior.

This refines the publication boundary from the [Agent lifecycle and ownership decision](2026-06-18-agent-lifecycle-and-ownership-contracts.md) without replacing its ownership model.

## Superseded: the persistence-side preparation lifecycle

This note originally also gave persistence a `prepare(id)`/`inspect(id)` lifecycle: a coordinator-backed bounded LRU of cold unpublished Sessions with exclusive reservations, revision-checked reuse, and repair committed inside `prepare`/`load`, so history pagination and a later resume shared one cold materialization. The [handle-based persistence seam](2026-08-27-handle-based-session-persistence.md) deletes all of it: persistence exposes handles only, resume reads the log through its write handle and owns repair, and read-only observers (session-query) own their cold-Session cache keyed by the `stat().revision` change token. The read-reuse goal survives in that cache; the exclusive-reservation machinery does not, because the write handle's single-writer ownership is the exclusion resume actually needs. Resume pays one whole-log read through the handle where the prepared cache sometimes served a warm Session — an accepted cost recorded in the handle note.

## Boundaries

- The preparation is one disposable ownership window, not a cache: disposal is synchronous and idempotent, and publication accepts only the exact prepared Session.
- A fresh create never claims a persisted identity implicitly. Persistence collisions continue to reject (`SessionAlreadyExistsError`, `SessionAlreadyOwnedError`).
- Live Sessions are owned by the existing stores; preparations hold only unpublished ones.

## Verification

Agent-loop tests pin the common publication pipeline across create, `createAgent`, and resume, including rollback on setup failure, cancellation, and teardown, and that disposal releases the write handle (reopening for write succeeds). Session-store tests pin the restoration branch's validate-and-freeze-in-place transfer.

## Alternatives considered

**Activate an Agent for history reads.** Rejected because pagination would keep query-only Agents live and transfer cache retirement into the Agent lifecycle. This rationale still guards the session-query cold cache: observation never creates an Agent.

**Cache only `{ meta, events }`.** Rejected at the time because resume would still reconstruct a Session from the cached values. Under the handle seam this is exactly what the read side does — session-query caches a cold Session per revision for reads only — while resume rebuilds from the handle read, trading the warm-Session reuse for a single write-ownership door.

**Add a restore transaction or coordinator to the Agent loop.** Rejected because cold reading and Session construction are persistence and Session concerns. The Agent loop only needs the uniform `SessionPreparation` ownership boundary; the handle seam kept that split while moving repair to the loop's resume path.

## Consequences

Create and resume share one publication protocol without merging Agent and Session responsibilities, and every exit path disposes exactly one preparation. The persistence-side reuse consequences originally recorded here (shared cold materialization, LRU bounds, reservation coordination) now belong to the [handle note](2026-08-27-handle-based-session-persistence.md) and the session-query cache that replaced them.
