# Right Sidebar drag browser benchmark

English | [中文](README.zh.md)

The required Chromium case in [rightbar-drag.bench.ts](rightbar-drag.bench.ts) drags the right Sidebar's resize handle beside a synthetic 120-turn Session whose older pages are all loaded, and counts restyled elements and layouts during the drag. The shipped Web scaffold owns the isolated home, persistence, and loopback listener; Chromium loads the built Web artifacts.

## Run

`pnpm run test:bench` builds libraries, workers, and Web artifacts before running the serial benchmark inventory. With artifacts already built, select this directory through `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/rightbar-drag-browser`. A shell that exports `NODE_USE_ENV_PROXY` unsets it first, as the [test proxy setup](../../scripts/test-proxy-environment.ts) requires.

## Measurements

Two fresh browser processes and scaffold worlds each widen the Sidebar by 40 trusted mouse steps of 8px and drag it back in a 1680×1000 viewport. A Chromium timeline trace covers each drag through two animation frames after release. Column widths measured before and after the trace must stay below the 680px content-width floor: widening the Sidebar must narrow the transcript column, and narrowing it must widen the column.

- **Restyles:** Sum the elements reported by each style recalculation and divide by the page's element count. The upper median per direction must not exceed 1 (one page's worth).
- **Layouts:** Each drag must produce at least one `Layout` event. `layoutCount` includes them all; `scriptNestedLayoutCount` counts each layout fully enclosed by a script event on the same process and thread, including animation frame callbacks. This subset must not exceed 20 per drag (half the mouse steps). Nesting is a proxy for synchronous layout, not evidence that every nested layout is unnecessary; browser reflow outside script does not consume the budget.

Frame gaps and style and layout durations are diagnostics only. Neither budget scales with CPU speed.

The fixture contains mixed-language prose, lists, 12 code fences, 8 tables, reasoning, and 24 tool results. No model, tool, external network, recorded Session, or private Harness home supplies its content. The [decision record](../../.agents/notes/implemented/testing/2026-11-20-rightbar-drag-restyle-budget.md) owns the workload choice, calibration, alternatives, and exclusions.
