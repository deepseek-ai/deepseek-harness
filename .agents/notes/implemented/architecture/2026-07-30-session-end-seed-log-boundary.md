# Agent Note: the end-seed log boundary

Status: implemented

English | [中文](2026-07-30-session-end-seed-log-boundary.zh.md)

## Problem

A plugin that owns a standalone open/close bracket in the session log cannot tell a dead marker from a live one. `compaction/start` … `compaction/end` is the shipped case: on picking up a log whose last compaction event is an unmatched `compaction/start`, "the previous writer died mid-compaction" and "a compaction is running right now" are byte-identical stored history. The owner must either refuse to compact a log that is actually free (wedging the session) or proceed over one that is genuinely busy.

Nothing in the log marked where inherited history ended. `session/created`, `session/disposed`, and `session/flush` are cordis runtime signals, not log events; `agent/session-start` is emit-only. `Session.firstLiveSeq` already held the answer exactly — the seq of this lifecycle's first own write — but only in memory, so a consumer reading stored bytes could not see it.

Crash repair does not close the gap and must not: `interruptedTurnClosers` synthesizes turn, step, and tool boundaries because core owns that vocabulary, and `compaction/*` belongs to the compaction seam. A core repair pass that closed plugin brackets would put every plugin's bracket semantics in core.

## Decision

`Session`'s constructor appends the log-only `session/end-seed` event immediately after an explicitly supplied constructor seed, including an empty one, as the seeded session's first live write at the seq `firstLiveSeq` names. The event is the durable projection of that field: `firstLiveSeq` answers where this lifecycle's writes start for a consumer holding the object, while `session/end-seed` answers the same question for one holding only stored bytes. Its payload is empty — position and `time` carry the whole meaning — and it is not a `SurfaceEventType`, so it produces no message and cannot perturb derived history. The seq-0 marker distinguishes an empty resumed session from a genuinely fresh session, preventing new-session defaults from being applied during resume.

A bracket owner reads it positionally: an unmatched opening marker before `session/end-seed` has a smaller seq, came from the constructor seed, and belongs to a lifecycle that has ended. Core writes the boundary and reads nothing from it; each bracket's vocabulary stays with its owning plugin, so no core predicate helper ships without a consumer to shape it.

The constructor is the placement because it is the single waist every seeded session passes through. All six entry points reach it: `agents.resume()`, config-driven startup on a persisted id (`restoreOrCreateConfigured`), `sessions.fork()`, a subagent fork child, `coordinator.adopt()`'s live-prefix path, and a bare `sessions.create(id, {seed})`. A boundary written at persistence load would miss both fork paths — and a forked child inheriting a still-running parent's open `compaction/start` is precisely the case that must be classifiable. A boundary written at loop start would miss `fork()` and `adopt()`, and would have to fire on `SessionStartSource: 'startup'`, which is what a fork child publishes, so that field would stop discriminating.

Two guards keep the marker precise. An omitted seed writes nothing because the session is fresh. A seed already ending in one is not re-marked, which makes the write idempotent. Idempotence is load-bearing rather than tidiness: each Agent-bound pickup of a cold session passes through `agentFor()`, and without the guard repeated controls would grow the log even when they perform no work. The inspection-only `session.history` and `session.fork` source paths do not create this boundary in the source.

## Persistence needs no changes

The constructor append happens before `enter()`, so the session has no store attachment: the marker never publishes on `session/event`, exactly like the seed events before it. It is instead part of the log `initFor` captures as the creation seed, and persists through the ordinary seed path — `onCreated`'s `createCore` + `appendCore`, or the ownerless-claim suffix write. A consumer that watches the firehose therefore never sees the boundary and must read it from the log.

Consequences for the seam: `load()` stays a pure read, with no revision bump, no `commitRepair` on a balanced log, and no durable mark left by a rejected `append`. **Attaching is not a pure read**, though — a pickup now writes where nothing was written before, so a read-only or full disk fails at `session/created` rather than at the first real turn. That is the one cost this placement adds, and it is narrower than the load-path version's (which failed the load itself).

A crash before the seed write reaches disk loses the boundary, and that costs nothing: the pending batch is written in order, so a lost boundary means every event after it is lost too. The next pickup reads the same bytes the previous one did, appends its own boundary, and classifies the bracket identically. In-process consumers should prefer `firstLiveSeq`, which is exact before any write.

## Scope of the guarantee

The predicate holds for a bracket *this* session inherited, not as a liveness signal about other writers. A concurrently live session may hold an open bracket over the same stored history while its own boundary sits elsewhere. A consumer that must tolerate concurrent writers needs a liveness signal beyond the log and cannot omit it on the strength of this event.

## Alternatives considered

**A boundary written by the persistence coordinator's cold-load path.** An earlier iteration wrote a `session/resumed` boundary; it lost because it covers no fork — the one case where the inherited bracket's owner may still be running — and because a marker minted at load had to be a durable write on a read path, which spread cost across the seam: a revision bump on every cold load, a `commitRepair` batch on a balanced log with nothing to repair, a stored-time floor to keep the clamp monotonic, and a load that failed against a read-only store.

**A boundary appended at loop start.** The loop calls `resumeWith`, so it covers the resume paths, but it misses `fork()` and `adopt()` entirely, and the event would have to fire on `'startup'` — the source a fork child publishes — so `SessionStartSource` would stop discriminating. It also publishes the session before the marker is appended, so a `session/created` listener could observe a seeded log with no boundary.

**Reusing `Session.inheritedEventCount`.** It is the durable *fork-lineage* cut and deliberately keeps the original fork value across a resume, where the constructor seed is the whole stored log. The two facts differ and conflating them would lose both.

**Crash repair closing `compaction/*` alongside turn boundaries.** Rejected: it moves every plugin's bracket semantics into core's repair pass, and core cannot know what closing another package's bracket should record.

## Consequences

Bought: one boundary, written in one place, correct for all six seeded-start paths — including the fork gap the persistence-layer version could not reach. The persistence packages keep a pure read path. `firstLiveSeq` gains a durable twin rather than a second, competing notion of the same boundary.

Cost: a seeded session's log is one event longer, including an empty resumed log. Seq expectations move with that boundary. Two updates are load-bearing rather than mechanical: telemetry's adoption tests assert that capture begins with the current lifecycle's newly appended boundary and excludes the constructor seed, and the property suite's replay invariant is "seed reproduced verbatim, plus one log-only boundary" with idempotence as its own property.

`session/end-seed` joins the on-disk vocabulary. Current v1 requires the validated marker semantics owned by Session; the frozen v0 codec and migration edge own which historical v0 seed layouts remain admissible. The exact inherited cut stays separate from the logical header and is available after a body read.

The [queued manual compaction decision](../feature/2026-07-30-queued-manual-compaction.md) now supplies the first consumer. Its tail scan independently finds the unmatched `compaction/start` and newest end-seed, treats only a start after that boundary as live, and clears the invariant trace on the same replay transition. The predicate remains in the compaction package rather than becoming a generic core helper.
