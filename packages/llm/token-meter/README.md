---
description: "Replay-aware token and context-pressure measurement for users and maintainers sizing prompts or building compaction and occupancy displays."
kind: "package-reference"
---

# @deepseek-ai/dsh-token-meter

English | [中文](README.zh.md)

## Summary

Use `ctx.tokenMeter` to estimate a session's current request and context pressure or price one message. Measurements replay the durable session log, remain deterministic, and make no model calls, so compaction, occupancy displays, and telemetry can share one result. When session projections are available, consumers can read `tokenUsage`, `contextPressure`, and `contextBreakdown`; text and routes without image pricing use an approximate fixed heuristic, declared visual-token pricing applies when available, and files are priced as model-visible handle text. Provider-reported usage is reused only for an identical request envelope; the package adds no model-visible content and makes no loop decisions.

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

Each measurement resolves the effective envelope's provider/model through the optional `llm` service. Image occurrences use the routed request's visual-token price plus model-visible text when the adapter declares pricing, and occurrences selected by an `image/offload` event are priced as the route's placeholder text exactly as the surface sends them; other routes keep the fixed heuristic. File occurrences use the exact route-independent handle text that the same `llm` service resolves for adapter dispatch, including its current execution-world path or explicit no-path message. Each node also carries route-independent `heuristicTokens` for replacement shadow prices. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope and its total is no lower than that call's full route-priced anchor; otherwise the complete current envelope and surface are estimated. Surface changes stay signed relative to a matching anchor repriced under the same route, including negative deltas after shrinking replacements.

The measurement anchor includes the priced surface immediately before the successful `assistant/message`, including system and user messages admitted after `step/start` and replacements made before a retry. With unchanged durable output, the completed call has zero surface delta: its prompt is already included in provider usage. Later surface changes remain signed deltas against that anchor.

### Session projections

When the composition provides `ctx.sessionProjections`, token-meter registers three projection units. `tokenUsage` carries the complete durable log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. A final assistant-message sample replaces streaming usage from the same attempt; `llm/retry-started` ends that replacement scope, so a retry in the same step contributes another billed attempt. `contextPressure` carries optional `pressureTokens` (the newest provider-reported prompt size), optional `projectedTokens` (what the next request's prompt would cost), and optional `contextWindow` from the newest `request/context` record. `contextBreakdown` carries heuristic `systemTokens`, `toolsTokens`, and `messageTokens` — the context's composition, not its provider-billed size. Unloading the plugin removes all three keys.

Image offload reprices existing node identities while preserving prior usage anchors. The fixed reference heuristic excludes `offloaded` metadata, so an offload decision does not change `contextBreakdown` or the scalar heuristic total; route-aware measurement replaces the selected visual prices with placeholder text.

`contextBreakdown` classifies the last nonempty surviving `system/message` in surface order as `systemTokens`; empty dormant nodes contribute nothing, and no nonempty system means zero. `messageTokens` includes every other visible node, including superseded prompts. Their sum always equals `measure().nodes[].heuristicTokens`, including after unmetered replacements, compaction, and per-node prompt clearing. `toolsTokens` follows the latest `request/header`. All three use the fixed heuristic, not route image pricing or file-handle projection; they are approximate composition, not billing or `projectedTokens`.

`deriveTurnTokenUsage(events)` folds one complete turn into exact per-attempt and whole-turn usage for browser consumers. It returns no result when lifecycle evidence is missing, counts are unsafe, or exact totals conflict; each corresponding aggregate appears only when every participating attempt reports its optional cache, reasoning, or route value.

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

Each `measure()` call synchronizes the fold to the current durable tail, then reads one coherent snapshot. The fold tracks full request-header snapshots, step boundaries, surface appends and replacements, successful assistant messages, and provider usage. Provider output for a usage anchor is reassembled from the assistant message's exact embedded stream, independently of listener rewrites to durable content; empty assembled content costs zero.

### Projection semantics

`contextBreakdown` retains plain-JSON `{ seq, heuristicTokens, system }` entries in surface order and reuses the measurement plan/commit fold. Its state and surface transitions are O(current retained surface), not O(1) and not O(total historical log); replaced entries and message bodies are not retained. State version 5 invalidates checkpoints priced with offload metadata. `contextPressure` remains the scalar shadow-price consumer: replacements without adjacent claims contribute zero delta. The usage fold retains one last-sample slot because legal logs never report usage for an earlier step after a later step reports usage.

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
- **Provider usage is only reusable for an identical canonical envelope** — tools, provider, model, or call-config changes deliberately fall back to full heuristic estimation; system-prompt changes are signed surface deltas until the next successful call.
- **A system-prompt rewrite carries no shadow price** — the loop replaces a system node without an adjacent metering event, so `contextPressure.projectedTokens` folds that replacement at zero delta until the next usage sample; `contextBreakdown.systemTokens` and `measure()` reprice the new prompt immediately.
- **Composition checkpoints retain the current surface** — exact system/message classification needs positional entries; checkpoint size and surface-event folding are O(current retained surface).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The fixed four-characters-per-token heuristic underprices CJK text and JSON schemas; the provider anchor carries exactly that error when usage is reused. Present the composition rows as an approximate composition, never as a total.
- A per-provider exact tokenizer is not decided; keeping one deterministic heuristic is what makes every consumer's measurement agree and replay-stable.

</details>

**Runtime invariant:** No companion is published. Usage folds replace samples within each attempt; totals need not be monotone. Composition and measurement share the positional replacement planner and fixed estimator, so their heuristic surface totals agree by construction rather than through independent mutable observations. Route-priced totals deliberately differ.
