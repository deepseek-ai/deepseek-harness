# Agent Note: the context meter could not see a compaction

Status: implemented

English | [中文](2026-08-05-context-meter-blind-to-compaction.zh.md)

## Problem

The composer's [context meter](../feature/2026-08-05-composer-context-meter-breakdown.md) took its ring, percentage, and `~used / capacity` header from `contextPressure.pressureTokens`, the newest provider-reported prompt size. That number moves only when a request reports usage, and compaction reports none: `compaction-basic` summarizes through a direct `ctx.llm.stream()` call and appends `compaction/start`, `compaction/summary`, the replacement `user/message`, and `compaction/end` — no `assistant/message`, no usage chunk.

So the meter was frozen across the one action taken to change it. Driving a real `compactNow` through the agent loop:

```
BEFORE compact:  ring=4%  header=~4227/100000   rows=[system 18, tools 0, messages 4365]
AFTER  compact:  ring=4%  header=~4227/100000   rows=[system 18, tools 0, messages  286]
```

The composition rows, which fold the surface, dropped by 93%. The ring — the primary affordance, and the reason a user opens the panel right after compacting — did not move at all, and would not until an entire further turn completed. The panel then showed a header and rows disagreeing by more than an order of magnitude, at exactly the moment a reader was most likely to add the rows up.

## Decision

`contextPressure` publishes a second numerator, `projectedTokens`: the provider sample plus the heuristic repricing of everything the surface gained or lost since that sample was taken, clamped at zero. The fold carries the priced surface through the shared `surface-fold.ts` and stamps `sampledSurfaceTokens` when a usage sample lands — **before** the same event joins the surface, so an `assistant/message` anchors against the surface its own request actually carried. `stateVersion` moves to 3.

Only the delta is estimated. The anchor stays provider-exact, which keeps the estimator's systematic CJK and JSON-schema underpricing out of the occupancy figure while still letting the number react the moment content lands or a span is shadowed. `contextOccupancy` reads `projectedTokens` and falls back to the bare sample, so a projection restored from a pre-field checkpoint degrades to the old behavior instead of vanishing.

This reverses the "the ring, header, and bar length stay provider-exact" half of the [context meter decision](../feature/2026-08-05-composer-context-meter-breakdown.md). What that decision was protecting — not fabricating precision by scaling heuristic rows to a provider total — is preserved: the rows are still unscaled, and the header still does not equal their sum. What changed is the recognition that "provider-exact but describing a request two compactions ago" is not the more truthful figure.

## Alternatives considered

**Project `measure().totalTokens` instead.** The measurement service already composes exactly this (`baseline` anchor plus signed `surfaceDeltaTokens`), and it reacts correctly — measured at 4383 → 304 across the same compaction. But it is a service over private replay state, not a pure fold, and a projection cannot call it. Reproducing its anchor inside a `ProjectionDefinition` needs `_estimateProviderAssistant`'s random access to the chunk events cited by seq (`session.eventAt(seq)`), which `apply(state, event)` does not have. Anchoring on the sampled surface total is the same idea reachable from a pure per-event fold.

**Emit a synthetic usage record at the end of compaction.** Would move `pressureTokens` itself, but the only usage compaction holds is the summarization request's own — a different prompt entirely. Recording it as the conversation's prompt size would be a lie in the durable log rather than in one display.

**Let the UI subtract, exposing `sampledSurfaceTokens` and reading `contextBreakdown.messageTokens`.** Splits one figure's arithmetic across two projections and the client. The host owns the vocabulary; it should publish the whole value.

## Consequences

Occupancy now advances with every surface event rather than once per turn, so the ring creeps up as a turn produces tool results instead of jumping at its end — and drops the instant a compaction lands. That is more projection frames on the wire: one per surface event for `contextPressure`, the rate `contextBreakdown` already ran at.

The panel's composition rows still do not sum to the header, and now for one clearly-stated reason instead of two: the rows carry the estimator's error, the header's anchor does not. The remaining lever is estimator accuracy (CJK-aware weighting in `estimate.ts`), which changes no seam.

`sampledSurfaceTokens` assumes nothing joins the surface between a step's request and its usage report. The loop admits steering and context before `buildRequest` and drains tool results after `assistant/message`, so that holds; if it ever stops holding, the error is bounded by one message and self-corrects at the next sample.

## Testing

`packages/llm/token-meter/tests/token-usage-projection.spec.ts` covers the carry-forward across surface growth and a compaction (the sample holding still while the projection shrinks) and the zero clamp when heuristic error would drive the figure negative. `packages/client/ui-conversation/tests/context-meter.client.spec.tsx` pins the ring reading the projected figure, and `chat-stats.spec.tsx` pins `contextOccupancy`'s preference and its fallback. The end-to-end numbers above came from driving `BasicCompactionEngine.compactNow` through a real `AgentLoop` with the projection registry mounted.
