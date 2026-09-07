# Agent Note: Token-meter surface fold commits in place through a plan/commit pair

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-token-meter-surface-fold-plan-commit.zh.md)

## Problem

`foldSurfaceTokens` rebuilt the meter's priced surface on every surface event: an append allocated `[...nodes, node]` and a replacement copied the whole array before splicing. The copy existed for one property — a throw must leave the caller's `ReplayState` untouched so a malformed event fails identically on every retry — but it charged every WELL-FORMED event O(surface) for it. Benchmarks on this fold showed the copy was ~99.9% of an append's cost (100µs at a 50k-node surface versus 0.1µs for the pricing itself), and successive appends accumulate O(S²) over a session's life, concentrated in exactly the long sessions users report as sluggish. The token meter folds inside the synchronous `session/event` publication path, so this cost lands on the agent loop's streaming appends.

## Decision

Split the fold into the session core's existing `planSurfaceEvent`/`applySurfacePlan` shape: `planSurfaceTokens` performs every fallible step (message pricing, replacement-range resolution) against the read-only surface and returns a `SurfaceTokenPlan`; `commitSurfaceTokens` applies a plan in place — `push` for an append, one `splice` for a replacement — and is infallible by construction. `TokenMeter._foldEvent` plans first, runs the remaining fallible anchor validation (step pairing, provider-chunk provenance), and only then commits, so retry identity is preserved by ordering instead of by allocation. Appends drop from O(surface) to amortized O(1); replacements keep their O(surface) `findIndex` but stop paying the extra full copy.

`measure()` still detaches its result with `structuredClone` + `deepFreeze`, so in-place mutation of the meter-owned array never escapes to callers.

## Testing

The existing malformed-replay suite already pins retry identity (`expectRepeatedFailure` asserts the same throw twice for out-of-range replacements, missing step boundaries, and bad provenance). A new regression test covers the hazard this change introduces: an event whose surface plan is valid but whose later anchor validation throws must leave the priced surface and running total uncommitted across repeated failures — under a mis-ordered in-place commit the throw pattern would still match while the surface silently double-counted. The full token-meter and compaction suites exercise both commit arms through real prune and summary replacements.

## Alternatives considered

**A seq→index map to make replacements O(1) too.** Rejected for now: index shifts on every splice force an O(surface) rebuild per replacement anyway, and replacements are orders of magnitude rarer than appends (compaction summaries and prune passes only). The append path was the quadratic term.

**Keeping the allocation and sharing structurally (persistent vector).** Rejected: a dependency or hand-rolled structure for a single internal array is not justified when the plan/commit ordering already provides the atomicity the copy existed for.

## Consequences

The fold no longer contributes a quadratic term to long-session append cost; the meter's remaining per-event costs are the `Session.events` snapshot read in `_sync` (addressed independently by the indexed log-read work, PR #1724/#2907) and O(content) pricing, which is inherent. `SurfaceTokenFold` (the old detached-result type) is gone; `surface-fold.ts` is package-internal, so no external consumer changes. The [composer context-meter note](../feature/2026-08-05-composer-context-meter-breakdown.md) records the projection design around this fold.
