# Agent Note: Record last activity in the session index

Status: proposed

English | [中文](2026-07-29-durable-last-activity-index.zh.md)

## Problem

A cold (persisted, unattached) session has no authoritative stored answer to "when did the user last prompt here". `dsh-host-apiproxy` serves `updatedAt` from the optional projection cache's `lastPromptAt`, falling back to `createdAt`, and the Web client sorts its Session tree by that value. The cache is fail-soft and checkpointed asynchronously, so a missing or delayed row makes a recently prompted Session sort too old.

The gateway previously used JSONL artifact mtime when available. mtime answers a different question: when the artifact was last written. Every durable write refreshes it, including a truncate-repair of a torn tail, synthetic closers that balance an interrupted turn, and the [`session/end-seed` boundary](../../implemented/architecture/2026-07-30-session-end-seed-log-boundary.md) appended during pickup. That approximation promoted a Session merely because it was opened. The [bounded cold blank verification](../../archived/bug-fix/2026-08-13-bounded-cold-blank-verification.md) removed mtime ordering and accepted the cache's conservative "too old" failure direction as an interim tradeoff.

An attached summary can fold the live event log and select the latest human-authored `user/message`, but the cold path deliberately reads no logs: cold summaries come from the projection cache alone, so cold recency is only as fresh as the cache.

Making cold ordering exact remains a durable-format decision, which is why it is scoped here rather than in the gateway workaround.

## Proposal

Store the latest human-prompt time where a listing already reads — the Session index — so `summarizeCold()` can serve it without opening the log or depending on a cache checkpoint. The coordinator computes the value because it sees every append and already owns per-id state; backends persist it. That makes it a new `PersistenceBackend` contract element rather than backend-local bookkeeping, with the same event predicate as the attached projection: `user/message` whose `source.kind` is `user`.

The shipped JSONL backend determines the concrete storage constraint. Its header is line 1, written once during materialization, and the log is opened for append forever after; `jsonl.spec.ts` pins that committed bytes are never rewritten. A per-append header field would violate an asserted durability invariant, not merely complicate the writer. A per-session sidecar file is therefore the shape to compare against leaving JSONL approximate. An out-of-tree backend may store the value in its own index only if it defines the update atomicity, versioning, and recovery semantics for that representation; this proposal does not prescribe another provider's schema.

Three questions must be answered before implementation, and none of them is settled here:

**How is the shared predicate owned?** A stored field encodes the rule at write time, where the writer sees one batch, while the attached summary folds a whole log. Both must use one exported event predicate or reducer so new message-source variants cannot make attached and cold ordering disagree.

**How do pre-field logs behave?** Existing artifacts have no value. Falling back to mtime keeps them at the existing mtime-based accuracy; falling back to `createdAt` is honest but reorders every existing session in the picker and the tree.

**Is a sidecar acceptable for JSONL?** It reintroduces a second file per session that can disagree with the log, which the single-artifact design avoided.

## Alternatives considered

**Read the log on the cold path.** Correct by construction and needs no format change, but it defeats the header-only listing: `list()` would scale with total log size, and the web session tree fans out over every session in the store. This is the option the mtime approximation exists to avoid.

**Keep mtime and exclude boundary writes from it.** Rejected as impossible rather than undesirable: mtime is the filesystem's, not the backend's. Nothing short of restoring the timestamp after every boundary write would preserve it, and that races any concurrent reader and lies about the artifact.

**Write the boundary only when repair occurred.** Would reduce the frequency, and the [boundary note](../../implemented/architecture/2026-07-30-session-end-seed-log-boundary.md) already rejected it: the predicate must hold for an orderly restart too. Trading a correctness invariant for timestamp accuracy is the wrong direction.

**Derive activity from a projection cache.** This is the current interim implementation. `session-projection-cache` folds tails past a watermark without changing the persistence format, but it is optional and fail-soft. Its absence or checkpoint delay makes ordering depend on cache availability and freshness, so it cannot provide the authoritative value proposed here.

## Acceptance criteria

- `SessionSummary.updatedAt` for a cold session equals the same value the attached projection reports for that session, verified by resuming, quitting without a turn, and asserting the order is unchanged across both paths.
- A resumed-then-abandoned session does not sort above a session worked in afterwards, in the web session tree and the TUI resume picker, pinned by an assembled snapshot rather than unit tests alone.
- The prompt-time rule has one definition: a test proves the stored field and attached fold agree over a log containing human prompts, injected user messages, boundaries, and closers.
- Pre-field artifacts load and list without error under the chosen fallback, with the fallback's ordering consequence asserted.
- The selected JSONL representation preserves committed log bytes and either updates the activity value atomically with the corresponding append or defines a conservative, observable stale-value failure mode.

## Risks

**Two definitions of prompt time drift.** The stored field is computed per batch, the projection over a whole log. A new message source classified one way at write time and the other at read time yields a Session whose cold and attached orderings disagree — a bug that only appears after restart.

**A JSONL sidecar can disagree with its log.** A crash between the log append and the sidecar write leaves a stale value with no torn-tail marker to repair it. Every consumer would need to treat the sidecar as a hint, which is close to what mtime already is.

**The fallback reorders existing sessions.** Whichever fallback is chosen, users with existing logs see their picker and tree reorder once on upgrade. `createdAt` makes that reordering large.

**Cost may exceed the defect.** The remaining defect is conservative misordering when projection metadata is missing or delayed. If the honest answer for JSONL is "keep the cache fallback", this note's outcome may be documenting that decision rather than implementing a field.

## Related

- [Bounded cold blank verification](../../archived/bug-fix/2026-08-13-bounded-cold-blank-verification.md) — removes mtime ordering and defines the interim cache-only cold summary this proposal would make exact.
- [The end-seed log boundary](../../implemented/architecture/2026-07-30-session-end-seed-log-boundary.md) — one of the non-prompt writes that made mtime unsuitable.
- [Session persistence](../../implemented/architecture/2026-06-14-session-persistence.md) — the append-only and never-rewrite invariants that rule out a mutable JSONL header field.
- [Handle-based session persistence](../../implemented/architecture/2026-08-27-handle-based-session-persistence.md) — the write-handle append path a stored field would hook into.
