# Agent Note: unpriced surface replacements fold neutrally

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-token-surface-unpriced-replace-compatibility.zh.md)

## Problem

The `contextPressure` and `contextBreakdown` projections keep a running surface-token total plus at most one pending shadow-price claim, so their persisted checkpoints stay O(1) over a session's life. Current replace producers append a `compaction/summary` or `compaction/prune` metering event immediately before the replacement; its `shadowedTokenCount` prices the exact replaced range, and `foldSurfaceProjection` turns that into the signed delta.

Sessions recorded before the shadow-price protocol log replacements with no adjacent metering event. The O(1) state cannot reconstruct the replaced range's price, and the fold treated every unpriced replacement as a contract violation and threw — so replaying such a session died at its first replacement (`token surface: replace at seq … has no adjacent shadow price`), leaving the session permanently unopenable.

## Decision

A replace that arrives with no armed claim folds price-neutrally: `foldSurfaceProjection` returns `deltaTokens: 0`, pricing the replaced range as if it had cost exactly what its replacement costs, and replay continues. A claim expired by an intervening event reaches the same neutral path, since the fold cannot distinguish it from a log that never metered.

An armed claim naming a **different** range still throws. There the metering event was adjacent, so the producer wrote contradictory adjacent events — a live shadow-price contract violation, not historical data, and it must fail loud rather than let the total drift silently.

Both projections share the one fold, so neither gains state fields nor bumps its `stateVersion`. `surface-fold.ts` and `ctx.tokenMeter.measure()` are unaffected: they hold the per-node priced surface and never needed the claim protocol.

## Alternatives considered

**Keep throwing.** Preserves the strict producer contract, but every pre-protocol session stays permanently unreplayable, and the projections exist to serve replay.

**Persist the full priced surface in the projection state.** Could price any replaced range exactly, but grows the checkpoint by one node per model-visible message without bound — defeating the O(1) constraint the shadow-price protocol exists to preserve (see [the context-meter note](2026-08-05-context-meter-blind-to-compaction.md)).

## Consequences

An unpriced replacement holds the total still instead of shrinking it, so the compacted-away span stays counted: `contextBreakdown.messageTokens` retains the overcount, and `contextPressure.projectedTokens` overestimates occupancy only until the next usage sample re-anchors it, because that figure tracks movement since the sample rather than the absolute level. Overestimating occupancy can only trigger an earlier compaction.

The loud failure survives where it still means something: a range-mismatched adjacent claim is a current producer bug and still throws.

## Testing

`packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` pins the neutral fold for the no-claim and expired-claim replacements, the throw for a mismatched claim, and the exact pricing for a matched one. `packages/llm/token-meter/tests/token-usage-projection.spec.ts` pins `contextPressure` holding still across an unpriced replacement.
