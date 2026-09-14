# Agent Note: Web diff cards compare contextual content

Status: implemented

English | [中文](2026-09-14-web-diff-context.zh.md)

## Problem

Filesystem result metadata carries before/after fragments that include unchanged context. Treating each complete fragment as removed or added mislabels shared lines and inflates both card and collapsed-row totals.

## Decision

The Web primitive derives line patches with the maintained `diff` library, using `maxEditLength: 256`. Each exact change includes up to three neutral context lines on either side; distant changes use separate hunks and shared context contributes to neither total. Beyond 256 additions/deletions per fragment, search stops and the complete old/new fragments render as a coarse replacement, including shared lines in the display, copy, and counts. The card and `diffTotals` use this same deterministic derivation. This remains Client presentation under the [tool presentation ownership decision](../architecture/2026-08-23-client-derived-tool-presentation.md), without changing persisted metadata or public props.

## Alternatives considered

Unbounded comparison stalls collapsed summaries on heavily changed fragments. A deterministic edit-distance limit preserves exact sparse edits regardless of file length; a wall-clock timeout could make the summary and body choose different results under load. A coarse replacement sacrifices alignment above the limit while retaining every input line. Caching or asynchronous rendering adds ownership and invalidation work that the bounded comparison does not require. Extending durable metadata or maintaining a custom diff algorithm is unnecessary for this presentation behavior.

## Measurement

A local CPU diagnostic bundled the production `DiffBlock.tsx` entry with esbuild (`--bundle --platform=node --format=esm`) and timed `diffTotals` under Node 26.5.0 on macOS ARM64. Each fragment has 10,000 lines: unique indexed lines replaced completely, 100 evenly spaced replacements, or alternating repeated `old`/`shared` versus `new`/`shared` lines. Input construction and module loading are excluded; returned totals remain reachable. These are function timings, not browser paint or input latency, and carry no CI timing threshold.

| Input | Unbounded milliseconds | Bounded search milliseconds |
| --- | --- | --- |
| Complete replacement | 6492.16, 6777.79, 6786.79 | 5.25, 4.66, 4.19 |
| 100 sparse replacements | 8.19, 4.58, 4.01 | 7.58, 4.26, 4.13 |
| Alternating repeated lines | 3383.13 | 10.26, 7.46, 5.52 |

The bound admits all 100 sparse replacements unchanged. The 129-replacement regression fails without it because the unbounded implementation returns exact counts instead of the required complete-fragment fallback.

## Consequences

The browser build includes `diff`. The bound limits edit-graph search, not wall-clock duration: normalization, fallback rows, and copied output still scale with input length, and expanded cards also derive their rows separately. The content-line rule treats a final newline as a terminator. Regressions cover exact output at 256 edits, complete coarse output above the limit, a sparse edit in 10,000 lines, shared and distant context, repeated lines, copied prefixes, and summary/footer parity. Authored and borrowed Session snapshots cover coarse and exact browser cards respectively.
