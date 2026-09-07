# Long-session browser benchmark

English | [中文](README.zh.md)

This reference describes the required Chromium workflow in [long-session.bench.ts](long-session.bench.ts). It opens a synthetic 240-turn Session, loads every older page, visits Trajectory, returns to Chat, and submits a paced reply while typing another draft. The shipped Web scaffold owns the isolated home, persistence, replay adapter, and loopback listener; Chromium loads the built Web artifacts, not a replacement development server.

## Run

`pnpm run test:bench` builds libraries, workers, and Web artifacts before running the serial benchmark inventory. With artifacts already built, select this directory through `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/long-session-browser`. Install Chromium through the benchmark workspace before the first run.

## Measurements

Three fresh browser processes and scaffold worlds produce raw samples and median verdicts. Open and paging end after the expected transcript state and two animation frames; this includes a rendering opportunity, not a hardware presentation timestamp. Paging reports every page and gates the median of each sample’s slowest page. Stream reports first visible reply, trusted draft typing, complete reply wall time, and Chromium main-thread task duration. Send lookup is scoped to the composer seat; reply-marker lookups and the input-event text witness read only the latest Assistant step, avoiding repeated whole-history text and accessibility scans. The input witness is installed before Send, and draft typing starts as soon as the first marker is visible, without an extra pre-input animation-frame wait. The actual first input event must observe an unfinished reply; completion waits for the new rendered turn-tail after Host settlement. After measurement, a trusted keystroke after DONE must fail the same overlap assertion. Open, the slowest older page, and first Trajectory use standard-hosted expectations of 900/700/500 ms. Shared 1.25× headroom gives limits of 1125/875/625 ms respectively; stream endpoint overhead budgets are unchanged. Heap after forced GC and DOM counts are diagnostics, not leak budgets.

The fixture contains mixed-language prompts, prose, reasoning, 20 code fences, and 40 synthetic tool results. Every historical Assistant includes a compact stream built by the production accumulator from matching reasoning, text, tool arguments, usage, and finish chunks. No model, tool, external network, recorded Session, or private Harness home supplies its content. Streaming uses 120 text deltas at 16 ms replay pacing through the real composer, agent loop, transport, and persistence.

The [decision record](../../.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md) owns calibration, exclusions, and alternatives. The larger [manual diagnostic](../../apps/web/tests/complex-history.perf.ts) remains separate.
