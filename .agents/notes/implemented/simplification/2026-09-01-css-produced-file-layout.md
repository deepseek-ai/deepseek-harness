# Agent Note: replace produced-file probes with CSS width bands

Status: implemented

English | [中文](2026-09-01-css-produced-file-layout.zh.md)

## Problem

The produced-files row duplicated every candidate chip in a hidden probe tree, synchronously read computed styles and element geometry in a layout effect, and repeated those reads whenever the row or a probe resized. That machinery existed only to choose how many labels fit on one line. Its forced layout work cost more than exact width-dependent chip counts were worth.

The produced-file discovery and Host-opening behavior remain owned by [opening a produced file from the web UI](../feature/2026-07-31-web-workspace-file-links.md). This decision changes only how that row handles limited horizontal space.

## Decision

The produced-files row is an inline-size query container. CSS width bands hide trailing chips from the six-file prefix and select the corresponding pre-rendered localized remainder label. The flex row performs the actual shrinking, and each basename uses CSS ellipsis while the selected remainder label keeps its intrinsic width. `ProducedFiles` has no resize observer, layout effect, layout state, duplicate chip probes, computed-style lookup, or element-geometry read.

The row keeps its chip maximum and gap as local CSS custom properties. Each width band corresponds to that budget and reveals one matching remainder label when paths are omitted, so `+ N files` remains accurate for the CSS-selected prefix. The same selected label controls whether the existing Host-gated **Show in folder** action is visible.

## Alternatives considered

- **Observe only the row and estimate from its width** — this removes content measurement but still creates one observer and width-driven React state per mounted result row even though CSS already receives the same width.
- **Always render six chips and let flexbox shrink them** — this removes all sizing logic but can reduce six filenames to nearly empty targets on a narrow conversation column. CSS width bands retain useful labels without runtime observation.
- **Wrap or horizontally scroll every chip** — wrapping changes the turn's vertical rhythm, while horizontal scrolling makes the tail hard to discover. The fixed cap keeps the row bounded without either interaction.

## Consequences

Mounting and resizing the row performs no JavaScript layout work. Because fixed width bands ignore actual text widths and localized remainder widths, they may show one more or fewer chip than exact measurement would; flex shrinking and clipping preserve the single-line layout, and the selected `+ N files` label still counts every omitted path. Rendered files preserve their full path in the accessible name and `title`. Each row carries at most six short remainder spans, of which CSS exposes zero or one. The assembled browser test verifies responsive omission, one-line layout, and the absence of horizontal overflow.
