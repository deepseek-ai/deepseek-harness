# Right Sidebar drag browser benchmark

English | [中文](README.zh.md)

The required Chromium case in [rightbar-drag.bench.ts](rightbar-drag.bench.ts) drags the right Sidebar's resize handle beside a synthetic 120-turn Session whose older pages are all loaded, and counts the elements Chromium restyles during the drag. The shipped Web scaffold owns the isolated home, persistence, and loopback listener; Chromium loads the built Web artifacts.

## Run

`pnpm run test:bench` builds libraries, workers, and Web artifacts before running the serial benchmark inventory. With artifacts already built, select this directory through `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/rightbar-drag-browser`. A shell that exports `NODE_USE_ENV_PROXY` unsets it first, as the [test proxy setup](../../scripts/test-proxy-environment.ts) requires.

## Measurements

Two fresh browser processes and scaffold worlds each drag the handle 40 trusted mouse steps of 8px outward and then back, in a 1680×1000 viewport where the transcript column stays below the 680px content-width floor; each drag asserts that column width, so the resolved content width does not change. A Chromium timeline trace covers each drag through two animation frames after release. The budget is the median, per direction, of the elements counted by every style recalculation divided by the page's element count, and it must not exceed 1: the drag restyles less than one page's worth of elements in total. The count is dimensionless and does not scale with CPU speed.

Before the Conversation width axis kept its resize inputs on the body, every frame restyled the whole transcript: 200-turn local samples restyled 51 and 66 times the page's elements. Afterwards the same drags restyle 0.09 and 0.12 times, and the 120-turn workload 0.14 and 0.18 times; the count is independent of the history length. Frame gaps, style and layout milliseconds, and the final column width are reported as diagnostics only: layout still reflows the transcript at each new column width, which this case does not budget.

The fixture contains mixed-language prose, lists, 12 code fences, 8 tables, reasoning, and 24 tool results. No model, tool, external network, recorded Session, or private Harness home supplies its content. The [decision record](../../.agents/notes/implemented/testing/2026-11-20-rightbar-drag-restyle-budget.md) owns the workload choice, calibration, alternatives, and exclusions.
