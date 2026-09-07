# Agent Note: Full-session stats-strip figures through a sessionStats projection

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-full-session-turn-step-counts.zh.md)

## Problem

The web chat stats strip folded `StatsLine`'s loaded conversation window (`deriveStats` over `chat.legacy.nodes`) for every non-token figure: the "N turns · M steps" counter, the LLM and tool wall times, and the TTFT/throughput averages. History is paged 50 messages at a time, so each 加载更早 (Load earlier) click grew the window and every figure with it — 7 turns · 44 steps became 10 turns · 89 steps after one page, and the LLM duration climbed the same way. The product expectation is whole-session figures independent of how much history a client has loaded. Token accounting in the same strip already had the correct architecture: the durable `tokenUsage` projection.

## Decision

A new function plugin `@deepseek-ai/dsh-session-stats` registers a `sessionStats` projection unit on `ctx.sessionProjections`, mounted as a web-app bundle row. The value carries the strip's whole non-token figure set — `{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`, field names mirroring the window fold so the two swap wholesale. `steps` counts `step/end` events and `turns` counts distinct turns carrying at least one (turn numbers are monotonic, so one `lastTurn` slot suffices); `llmMs` sums `step/start` → `assistant/message`; TTFT records the first non-empty delta chunk per step (surviving in-step `llm/retry`, the window `resetForRetry` parity); decode spans first token → assembled message on usage-reporting steps; `toolMs` pairs `tool/call` → `tool/result` by callId with unresolved calls dropped at `turn/end`. The first-token predicate `isTokenDelta` moved to `@deepseek-ai/dsh-llm/message` (beside the `StreamChunk` type it discriminates) so the host fold and the client timing index share one implementation; client-runtime re-exports it. Delivery is entirely the existing projection seam — history tail-page block, `session/projection` push frames, list rows — with zero changes to apiproxy, wire schemas, or the client runtime. `StatsLine` reads `useProjection('sessionStats')` and falls back to the window fold when the key is undefined (an assembly without the unit). The client connection fixture mirrors the fold as `sessionStatsOf` under its existing every-composed-key discipline.

`step/end` — not `assistant/message` — is the counted event, for two correctness reasons found while reviewing the obvious message-counting design:

1. A max-tokens step appends an empty-content `assistant/message` that exists only to host usage and never reaches the surface; counting messages would count a step the transcript does not show.
2. A cancelled step aborts before its message assembles (no `assistant/message` at all), yet the client synthesizes a visible interrupted assistant node; counting messages would silently drop common cancelled steps.

`step/end` is appended exactly once per entered step, in the loop's `finally`, so completed, failed, cancelled, and max-tokens steps all land one — and the counter advances at step settlement, the same moment the window fold advanced, so live behavior does not shift.

## Alternatives considered

**Count `assistant/message` events.** Rejected for the two correctness defects above (overcounts usage-host messages, undercounts cancelled steps).

**Count `step/start` events.** Equivalent coverage (it precedes every `step/end`), but the counter would advance when a step begins instead of when it settles — a visible live-behavior change with no benefit; `step/end`'s `finally` placement gives the same completeness.

**Register the unit in `core/agent-loop` (the event producer).** The loop is the product spine; a UI read model there adds a session-projection dependency to every assembly, against "plugins, not loop changes" and "keep opt-ins out of shipped defaults".

**Register the unit in `token-meter` (an existing fold over the same events).** Turn/step counting is not token measurement; every projection key lives in the package owning its domain.

**Fold the full log client-side.** The client holds only the paged window by design; the projection RFC's no-client-folding rule exists exactly so figures survive paging, compaction, and cold reads.

**Keep wall times, TTFT, and throughput window-scoped, reading them as "what is on screen".** Rejected: the same paging complaint applies to the LLM duration, and a strip mixing whole-log counts with window-scoped times reads as one inconsistent figure set. The projection carries the whole set, with the window fold demoted to the no-unit fallback.

## Consequences

The strip shows whole-log figures from the first tail page; paging leaves every group fixed. Defined edge differences from the old window semantics are documented in the package README: a step that produced no visible output (failed before content) still counts, a step interrupted by a crash counts once recovery closes it with a synthetic `step/end` on reload (`interruptedTurnClosers`), a cancelled step is counted but contributes no wall time (no message assembled), and a max-tokens usage-host message contributes model time the surface does not show. Every web tail page and list row carries one more small key, and the unit's internal state changes on step boundaries and first-token chunks, so the change feed emits a few value-identical frames per step; TUI and headless assemblies serve no `sessionStats` key and any consumer falls back to window folding. Two e2e probes that had parsed the strip as a loaded-window measure (`chat-scroll-contract`, `complex-history.perf`) now count mounted flow rows / turn-tail footers instead. The `stats-paged-history` web scenario seeds a 28-turn log cold and pins that the whole strip reads full totals on a partial tail page and does not move across Load earlier.
