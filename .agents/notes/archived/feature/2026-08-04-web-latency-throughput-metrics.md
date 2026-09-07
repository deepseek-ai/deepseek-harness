# Agent Note: Web turn and window latency/throughput metrics

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-web-latency-throughput-metrics.zh.md)

## Problem

The Web chat records per-step LLM timing (`stepStartTime` / `firstTokenTime` / `completedTime`) and per-step usage, and the trajectory view exposes them per step, but the chat surface answers neither "how responsive was this turn" nor "how fast is this session going": the assistant footer shows only the turn wall time, and the stats line folds only wall-time totals.

## Decision

A package-local fold, `ui-conversation`'s `chat/turn-metrics.ts`, is the single derivation from assistant nodes to latency/throughput readings. `assistantStepReading` turns one node into a step reading: TTFT needs both `stepStartTime` and `firstTokenTime`, decode span needs `firstTokenTime`, negative spans clamp to zero, and output tokens come from the untrusted `usage` value only when they are finite and non-negative. `deriveTurnMetrics` folds readings per turn: the lowest-numbered step owns the turn's TTFT slot, and throughput divides the summed output tokens by the summed decode spans over exactly the steps carrying both, so an unsampled step drops out instead of skewing the ratio; a turn with neither figure emits no entry.

The assistant footer appends the readings to the existing hover-revealed time chrome after `Ran for`, as `TTFT {s}s · {tps} tok/s`, each omitted independently when unrecorded. ChatView shows a turn's readings only when that turn's `turnTimings` entry has an `endTime`: the loaded window is a contiguous log suffix, so an in-window settled turn carries every one of its steps and the first-step TTFT is genuine rather than a window artifact. `formatLatencySeconds` is unit-less so each locale template owns its second suffix (`TTFT {seconds}s` / `首 token {seconds}秒`).

The stats line reuses the same step reading in its window fold: `deriveStats` accumulates TTFT sum/count and decode span/tokens, rendering a latency/throughput group localized through the `conversation` locale namespace (`TTFT avg … · … tok/s` in English) beside the LLM/tool wall times. The turn-count, step-count, duration, cache, and token labels use the same namespace. Like those wall times the group is window-scoped and folds no billing; token accounting stays on the token-meter projections.

## Alternatives considered

**A durable session projection (token-meter shape).** A `ProjectionDefinition` folding step timings host-side would survive compaction and window paging and cover the whole log. Deferred, not rejected: projection state must stay O(1) (averages, not percentiles), it needs a host change plus a schema, and the chat stats line is documented as window-scoped for its duration facts. A durable projection can be added without moving these readings.

**Per-step footer chrome.** Showing each assistant message its own TTFT would attach chrome to mid-turn narration nodes, which the footer design deliberately keeps chrome-free; the trajectory view already exposes per-step timing detail.

**Gating footer metrics on node presence instead of `turn/end` timing.** Rendering whatever steps happen to be loaded would show a plausible-looking TTFT that is actually the first *loaded* step after paging. The `endTime` gate plus the suffix-window invariant makes the displayed figure the turn's true first-step latency or nothing.

## Consequences

A settled in-window turn's footer reveals `TTFT`/`tok/s` on hover after the wall time, and the stats line shows window-average latency and throughput with localized labels beside its wall times, all without new session events or host changes. Metrics degrade by omission: providers or steps without timing or usage samples drop individual figures rather than rendering zeros. Older history outside the loaded window stays uncounted, recorded in the package README's stats-line limitation.

Both readings divide by measured wall time, so neither is reproducible: the same replayed scenario yielded 69 and 70 tok/s on consecutive local runs, and a 3 ms replayed stream reads 26333 tok/s. The Web aria goldens therefore normalize throughput to `{{throughput}}` beside the existing `{{duration}}`, and the footer's decorative separators gained flanking spaces — without them the readings concatenate into one accessible string (`Ran for 13sTTFT 0.2s12 tok/s`), which both loses the reading boundaries a screen reader needs and denies `{{duration}}` the word boundary it matches on.
