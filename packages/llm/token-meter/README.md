---
description: "Replay-aware token and context-pressure measurement for users and maintainers sizing prompts or building compaction and occupancy displays."
kind: "package-reference"
---

# @deepseek-ai/dsh-token-meter

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-token-meter` is the replay-aware token measurement service: `ctx.tokenMeter` advances one isolated fold per session from the durable event log, so compaction and other pressure-sensitive plugins share one accounting without depending on the compaction engine. With it you can measure current request and context pressure, price a single message, and — when the session-projection seam is mounted — read the `tokenUsage`, `contextPressure`, and `contextBreakdown` projections. It uses a fixed heuristic for text and routes without image pricing, applies adapter-declared visual-token pricing when available, and reuses provider-reported usage only when the request envelope matches exactly. It adds no prompt, message, schema, or tool of its own, and it never makes decisions for the loop.

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

Mount this plugin when a consumer needs token or context pressure for compaction decisions, occupancy displays, or telemetry. The estimator has no settings and adds no model-visible surface; model capacity belongs to the adapter that owns the exact provider/model route and is available through `ctx.llm.resolveModelInfo().context`.

### When to choose it

Choose it when several plugins should agree on one replay-based measurement — compaction planning, occupancy UIs, and pressure checks all read the same fold. The measurements replay the durable session log, so they are deterministic, cost no model calls, and reflect exactly what is logged. Text and undeclared image routes use a fixed heuristic; reach for a provider tokenizer when a deployment needs exact billing-grade counts.

### Measuring pressure

`ctx.tokenMeter` exposes two operations. `measure(session, requestHeader?)` returns a detached, deeply immutable snapshot at one consumed-log revision: `totalTokens` is request-and-response pressure, and `surfaceTokens` is the surface-only route-priced total equal to the sum of `nodes[].tokens`. An optional `requestHeader` override selects the priced route and pressure fields; the node set still describes the current session. `estimateMessage(message)` prices one message with the fixed heuristic. Every call clones the positional surface nodes, so measurement is O(surface).

```text
const { totalTokens, surfaceTokens, nodes } = ctx.tokenMeter.measure(session)
const price = ctx.tokenMeter.estimateMessage(message)
```

Each measurement resolves the effective envelope's provider/model through the optional `llm` service. Image occurrences use the routed request's visual-token price plus model-visible text when the adapter declares pricing; other routes keep the fixed heuristic. Each node also carries route-independent `heuristicTokens` for replacement shadow prices. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope and its total is no lower than that call's full route-priced anchor; otherwise the complete current envelope and surface are estimated. Surface changes stay signed relative to a matching anchor repriced under the same route, including negative deltas after shrinking replacements.

### Session projections

When the composition provides `ctx.sessionProjections`, token-meter registers three projection units. `tokenUsage` carries the complete durable log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. A final assistant-message sample replaces streaming usage from the same attempt; `llm/retry-started` ends that replacement scope, so a retry in the same step contributes another billed attempt. `contextPressure` carries optional `pressureTokens` (the newest provider-reported prompt size), optional `projectedTokens` (what the next request's prompt would cost), and optional `contextWindow` from the newest `request/context` record. `contextBreakdown` carries heuristic `systemTokens`, `toolsTokens`, and `messageTokens` — the context's composition, not its provider-billed size. Unloading the plugin removes all three keys.

`contextBreakdown` carries heuristic `systemTokens`, `toolsTokens`, and `messageTokens` — the context's composition rather than its provider-billed size. The envelope figures reprice last-wins on every `request/header`; the message figure replays the same O(1) shadow-price fold as `contextPressure`, so on fully metered logs it equals the sum of `measure().nodes[].heuristicTokens` at every event boundary and compaction shrinks it by its logged shadow price. The route-priced `measure().surfaceTokens` diverges when the routed model reprices images. A replacement without an adjacent shadow-price claim leaves this bounded projection unchanged because it cannot reconstruct the replaced range. All three figures use the measurement service's fixed heuristic and are estimates: they will not sum to `projectedTokens`, whose provider anchor carries exactly the error — CJK text and JSON schemas underprice badly at four characters per token — that the composition rows still contain. Present them as an approximate composition, never as a total.

`deriveTurnTokenUsage(events)` folds one complete Turn into exact per-attempt and total usage for browser consumers. Missing lifecycle evidence, unsafe counts, or contradictory exact totals return no result; optional cache, reasoning, and route aggregates appear only when every contributing attempt reports them.

### Composition

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-basic'
```

Both plugins have usable defaults. The meter consumes only the optional `llm` service, and only to resolve route-declared request-image pricing; compaction remains optional. A deployment configures capacity and image pricing on its LLM adapter and compaction policy on `dsh-compaction-basic`.

### Reading the numbers

Occupancy is a reference figure, not a billing record: nothing in the harness makes decisions from it, and compaction reads `measure()` instead. A UI computes occupancy by dividing measured pressure by the separately resolved capacity for the selected model. The `contextBreakdown` figures are estimates that will not sum to `projectedTokens`, whose provider anchor carries exactly the heuristic error — CJK text and JSON schemas underprice badly at four characters per token.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the service; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one fold and one anchor. Each session gets an isolated replay state — consumed-event cursor, canonical request header, priced surface, step boundary, and measurement anchor — advanced by folding the durable log. Provider usage anchors a measurement only when its canonical envelope matches and its total is no lower than the full route-priced cost of the same call; otherwise the complete envelope and surface are estimated. The route-independent `heuristicTokens` field keeps replacement shadow-price projections deterministic. The fold is total and allocation-fresh: a malformed event throws before any mutation, so the same log fails identically on every retry.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `TokenMeter` service: replay state, fold, `measure()` and `estimateMessage()` |
| [`src/estimate.ts`](src/estimate.ts) | The fixed heuristic: four characters per token plus block and role overhead |
| [`src/surface-fold.ts`](src/surface-fold.ts) | The positional surface fold shared with `measure()` |
| [`src/surface-projection.ts`](src/surface-projection.ts) | Shadow-price protocol for the O(1) projection units |
| [`src/usage-projection.ts`](src/usage-projection.ts) | `tokenUsage` and `contextPressure` projection definitions |
| [`src/breakdown-projection.ts`](src/breakdown-projection.ts) | `contextBreakdown` projection definition |
| [`src/client.ts`](src/client.ts) | Browser-safe client surface for projection consumers |
| [`src/turn-usage.ts`](src/turn-usage.ts) | Pure fold for exact per-attempt and per-Turn usage |

### Fold flow

Each `measure()` call synchronizes the fold to the current durable tail, then reads one coherent snapshot. The fold tracks full request-header snapshots, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and the chunk seqs each assistant message cites. Provider output for a usage anchor is reassembled from the exact cited chunk seqs; an explicit empty list means a known empty provider stream, while a missing legacy list conservatively treats the durable assistant output as provider output.

### Projection semantics

The projection units do not share the full surface fold because their persisted state must stay O(1). `surface-projection.ts` prices appends and consumes the shadow price logged immediately before a replacement; it keeps one running total and at most one pending claim, not per-node prices. Fully metered logs therefore match `measure()`'s plan/commit fold at each event boundary. A replacement without an adjacent matching claim leaves the bounded projection unchanged because it cannot reconstruct the replaced range. The single last-usage-sample slot relies on a session-log ordering property: once a later step reports usage, a legal log never reports usage for an earlier step again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the measurement service to the compaction consumer and the shared types.

- [Token meter subsystem](../../../docs/subsystems/token-meter.md) — the measurement semantics behind `ctx.tokenMeter`.
- [dsh-llm service](../llm/README.md) — the model-call service whose capacity metadata `resolveModelInfo()` serves.
- [Compaction capability](../../../docs/subsystems/compaction.md) — the pressure-sensitive consumer that reads `measure()`.
- [Projected token usage](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) — the design behind `projectedTokens` and the rejected atomic-pair comparison.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the message and block types this service prices.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers such as `dsh-compaction-basic`; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the measurement stops and future work begins. They are current package constraints, not a general token-accounting comparison or a task backlog.

- **The fixed heuristic is approximate** — text without reusable provider usage is priced by character count plus structural overhead, not an exact provider tokenizer or request serializer; only image occurrences on routes with declared pricing carry provider-exact visual tokens.
- **Every measurement clones the current surface** — coherent immutable snapshots make reads O(surface), including below-threshold pressure checks.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, provider, model, or call-config changes deliberately fall back to full heuristic estimation.
- **Missing legacy source seqs are handled conservatively** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The fixed four-characters-per-token heuristic underprices CJK text and JSON schemas; the provider anchor carries exactly that error when usage is reused, and present the composition rows as an approximate composition, never as a total.
- A per-provider exact tokenizer is not decided; keeping one deterministic heuristic is what makes every consumer's measurement agree and replay-stable.

</details>

**Runtime invariant:** No companion is published. Token estimates are per-call outputs and the private session cache is invalidated at its event mutation boundary. The package's three projections do expose observation streams, but their schemas fix the JSON payloads; the usage folds replace same-attempt samples, so totals need not be monotone when a final sample corrects an earlier chunk, and the composition fold prices through the same `estimate.ts` heuristic as the measurement service and subtracts producer-logged shadow prices derived from that service's own fixed-heuristic node prices, which makes its message figure equal the sum of `measure().nodes[].heuristicTokens` by construction rather than by a relation worth observing at runtime; the route-priced `surfaceTokens` deliberately diverges by the routed model's image repricing.
