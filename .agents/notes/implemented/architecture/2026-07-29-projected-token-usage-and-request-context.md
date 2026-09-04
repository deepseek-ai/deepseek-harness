# Agent Note: Projected token usage and context occupancy

Status: implemented

English | [中文](2026-07-29-projected-token-usage-and-request-context.zh.md)

## Problem

The Web stats line derived token totals from the currently loaded conversation nodes. That window is paged, so scrolling changed the totals, and compaction replaces visible content without preserving the billing behind it. Durable provider billing needs a source that survives both.

Context occupancy needs a numerator and a denominator that no existing surface carried to the browser: the prompt size of the latest request, and the capacity of the route it used.

## Decision

Both values are ordinary durable session-projection state. `@deepseek-ai/dsh-token-meter` registers two units when `ctx.sessionProjections` is present.

`tokenUsage` folds the complete durable log into uncached input, output, cache-read, and cache-write buckets. It expands each `assistant/message` or `assistant/attempt` stream and takes the last usage sample; a message's top-level usage takes precedence over its embedded sample instead of double-counting it. `assistant/attempt` therefore preserves usage from failed requests. A matching `llm/retry-started` boundary opens a new attempt, so a retry with the same `(turn, step)` contributes separately. Reasoning stays an output subdivision. Compaction and surface replacement do not erase earlier billing.

Token-meter also owns the shared pure attempt/Turn fold over durable events. It applies the same retry boundary while adding the stricter completeness and exact-total checks required by an exact per-Turn disclosure. A presentation consumer may select a complete Turn window and invoke that fold, but does not own or duplicate the accounting semantics.

`contextPressure` carries optional `pressureTokens` — the newest provider-reported prompt size, summing uncached input plus cache reads and writes, excluding output — and optional `contextWindow` from the newest `request/context` record. Neither field is synthesized before its source exists.

`request/context` is a new log-only session event recording registration-bound metadata for the route a request resolved to. AgentLoop appends it inside the step beside `request/header`, from the context metadata `prepareCall()` now returns alongside the resolved config — the same registration-bound lookup that already validated reasoning, so no second resolve happens. It is skipped when provider, model, and capacity all match the previous record. A route whose adapter advertises no capacity is recorded with `contextWindow` absent, clearing an older route's denominator.

Capacity deliberately stays out of `EpochHeader`. That type is the reconstruction contract — what a request was built from — and `headerEquals` compares it field-wise to decide whether a snapshot is a real `change`. Capacity is adapter metadata describing a route, so placing it there would let a capacity change masquerade as a request-envelope change and would drag it into the loop's reconstruction invariant.

Both units ride the standard projection lifecycle: history tail baselines, `session/projection` live frames, higher-seq-wins client storage, JSON checkpoints, cache recovery, and unit unload. There is no token-specific history field, mux frame, projector, revision counter, or client fence.

The Web `StatsLine` reads both through the standard `useProjection` seat. Window nodes still supply turn and step counts plus LLM and tool wall times — those answer "what is on screen" and are correctly window-scoped. Durable token and context groups remain when compaction leaves no visible assistant step. Cache writes count in billed input and in the cache-hit denominator. A deployment without token-meter drops the token groups; occupancy stays hidden until both pressure and capacity are known. The exact-overflow tooltip mounts its measuring child only for a non-empty line and retains one `ResizeObserver` while values change; text changes perform one direct measurement without replacing the observer.

## Context occupancy is approximate, and that is the decision

`pressureTokens` and `contextWindow` are independent last-wins fields, not one atomic observation. Switching models pairs a fresh capacity with the previous route's pressure until the next request reports usage, and the numerator describes the last request rather than the surface as it currently stands.

This was accepted deliberately. An occupancy percentage is a user-facing reference figure: nothing in the harness makes decisions from it, and compaction reads `measure()` directly instead. The TUI status line has always computed occupancy this way, dividing a `measure()` total by a capacity resolved separately for the selected model — so an atomic variant here would have been the outlier, not the norm.

The non-atomicity is deliberate, not a defect. A consumer that genuinely needs an exact same-boundary figure should call `ctx.tokenMeter.measure()` at its own request boundary, where both values are available together, rather than read this projection.

## Alternatives considered

**An atomic request-boundary snapshot delivered as a transient mux frame (implemented, then rejected).** An earlier revision emitted `session/model-request`: one non-replayable frame carrying `contextTokens` and `contextWindow` measured at the same `agent/model-request` boundary. Being the only non-replayable class on the mux stream is what broke it. Host and mux are independent SSE streams with no cross-stream ordering, so a request emitted before a removal could arrive after `host/session-removed` and revive a dead session's telemetry, while a legitimate request for a new lifecycle reusing the same id could be fenced by a late removal. `session/subscribed` is not lifecycle proof — it says a queue began subscribing to an id, not that a new in-memory session replaced an older one — and `lastSeq` is a durable watermark two lifecycles can share. A correct fix required a monotonic lifecycle generation on the frame, on subscription, and on removal, plus a client watermark comparison.

That cost bought a worse display: occupancy went blank after every reconnect and never moved while a conversation grew. It also made the transport adapter a measurement site calling the O(surface) `measure()` on every request, and expressed reconnect state through a synthetic `cancelled` open error the UI had to special-case.

**Fold the loaded node window in React.** Cannot survive pagination or compaction, and makes a presentation package reconstruct log semantics.

**Publish usage only with final assistant messages.** A request that reports a usage chunk and then fails would lose its billing.

**Resolve capacity inside token-meter.** The package documents itself as independent of model routing and is otherwise a pure reader that never appends to the log. AgentLoop already holds the resolved metadata where the header is written.

**Extend the `session.models` RPC with capacity.** The handler already resolves and discards it, so the field is nearly free — but `StatsLine` lives in `ui-conversation` while the model directory lives in `ui-model-selection`, and `ui-conversation` cannot depend on `ui-model-selection`. Delivering it would have required either a second dock entry splitting one text row across two plugins, or a cross-plugin store write.

**Add a context circle beside the model selector.** That placement suggests selected-model state. The stats line carries the figure without a duplicate UI or data path.

## Consequences

Token totals stay stable across pagination, compaction, replay, restart, and reconnect, because they are ordinary durable projection state recovered through the generic paths. The cross-stream reordering race is gone by construction rather than fenced.

Occupancy is approximate in the ways documented above. It is available immediately after restore or reconnect, since both fields are durable, at the cost of describing the last recorded request rather than an exact current boundary.

Each session log gains one small `request/context` record per route or advertised-capacity change. Token-meter is the canonical owner of durable usage semantics, including retry-attempt separation in the cumulative projection and the reusable exact attempt/Turn fold; Web Chat only selects a complete loaded Turn and renders the fold result. The TUI retains its live per-step map because it does not mount the generic projection seam, and the standalone browser fixture mirrors the unit. Connection and API Gateway carry no token-specific code, own no per-session metrics cache, and perform no measurement. The browser keeps two generic projection values and no connection-local telemetry; streaming text deltas do not force the stats line to recompute or churn layout-observer subscriptions.
