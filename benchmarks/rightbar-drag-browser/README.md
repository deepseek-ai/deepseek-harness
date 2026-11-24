# Right Sidebar drag browser benchmark

English | [中文](README.zh.md)

The required Chromium case in [rightbar-drag.bench.ts](rightbar-drag.bench.ts) drags the right Sidebar's resize handle beside a synthetic 120-turn Session whose older pages are all loaded, and counts restyled elements and layouts during the drag. The shipped Web scaffold owns the isolated home, persistence, and loopback listener; Chromium loads the built Web artifacts.

## Run

`pnpm run test:bench` builds libraries, workers, and Web artifacts before running the serial benchmark inventory. With artifacts already built, select this directory through `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/rightbar-drag-browser`. A shell that exports `NODE_USE_ENV_PROXY` unsets it first, as the [test proxy setup](../../scripts/test-proxy-environment.ts) requires.

## Measurements

Each Chromium trace spans one trusted drag through two animation frames after release. The benchmark uses two fresh browser processes and scaffold worlds, with the Session panel hidden.

- **Changing column:** Each sample widens the right Sidebar by 40 steps of 8px and drags it back in a 1680×1000 viewport. The rendered transcript column must narrow as the Sidebar widens and widen on return; both endpoints must be below the 680px content-width floor.
- **Fixed column:** The first sample also opens the same 120 turns in a separate page with fresh storage, a 2560×1000 viewport and a saved 720px content width. After the opening slide settles, the visible Sidebar must reach each of 40 steps of 2px, from 1152px to 1232px and back. Every delivered transcript column width must be 720px. The Session panel's reserve-room value at its dock probe must switch from 1px to 0px and back.

- **Restyles:** Sum the elements reported by each style recalculation and divide by the page's element count. For the changing column, the upper median per direction must not exceed 1 (one page's worth). For the fixed column, each direction must not exceed 0.10.
- **Individual style passes:** Every sample prints `restylePassesByElementCount`: a bucket such as `"3": 40` means 40 complete Chromium `UpdateLayoutTree` events each reported three restyled elements. These are element visits, not distinct DOM nodes across a drag or invalidation reasons. `peakStyledElements` is the largest count in one event; `peakCountPassMs` is the duration of that event (the longer duration wins a tie). Each fixed-column direction must keep every pass at or below 512 elements, even if the cumulative ratio passes.
- **Layouts:** Each changing-column drag must produce at least one `Layout` event. `layoutCount` includes them all; `scriptNestedLayoutCount` counts each layout fully enclosed by a script event on the same process and thread, including animation frame callbacks. This subset must not exceed 20 per drag (half the mouse steps). Nesting is a proxy for synchronous layout, not evidence that every nested layout is unnecessary; browser reflow outside script does not consume the budget.

The p95 and longest animation-frame gaps (`frameP95Ms`, `maxFrameGapMs`) span the gesture through the two frames after release, excluding trace startup and decoding. Frame gaps and style and layout durations are diagnostics only; the work-count budgets do not scale with CPU speed.

The fixture contains mixed-language prose, lists, 12 code fences, 8 tables, reasoning, and 24 tool results. No model, tool, external network, recorded Session, or private Harness home supplies its content. The [decision record](../../.agents/notes/implemented/testing/2026-11-20-rightbar-drag-restyle-budget.md) owns the workload choice, calibration, alternatives, and exclusions.
