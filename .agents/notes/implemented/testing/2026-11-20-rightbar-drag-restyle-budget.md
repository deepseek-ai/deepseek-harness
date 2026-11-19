# Agent Note: Right Sidebar drag restyle budget

Status: implemented

English | [中文](2026-11-20-rightbar-drag-restyle-budget.zh.md)

## Problem

Dragging the right Sidebar beside a long transcript stalled for hundreds of milliseconds per frame. The Conversation body published measured widths as unregistered, inherited custom properties on an ancestor of the whole transcript, so every frame restyled every transcript element, even when the resolved content width did not change; later resize observers that read geometry forced that work synchronously. Existing browser benchmarks open, page, and stream a long Session, but none resizes it, so the regression had no gate.

## Decision

The [right Sidebar drag benchmark](../../../../benchmarks/rightbar-drag-browser/README.md) joins the serial browser inventory. It loads a 120-turn synthetic Session completely, opens the right Sidebar, and drags its handle 40 trusted 8px mouse steps outward and back in a 1680×1000 viewport, in two fresh scaffold worlds and browsers. At that width the transcript column stays below the 680px content-width floor, and each drag asserts it, so the drag changes the column but not the resolved content width.

The budget is a dimensionless count: the elements reported by every `UpdateLayoutTree` trace event during one drag, divided by the page's element count, as a median per direction, at most 1. A drag that restyles the transcript on every frame reaches about one multiple per frame; the fixed drag stays far below one multiple in total. The count does not depend on CPU speed, so it takes neither the shared time scale nor the variance headroom, and no wall-clock endpoint is budgeted or passed to the scaling report.

## Calibration

Local Linux x64 Chromium samples, 40-step drags:

| Workload | Widen | Narrow |
|---|---:|---:|
| 200 turns, before the width axis change | 1,479,947 / 28,895 = 51.2 | 1,909,568 / 28,895 = 66.1 |
| 200 turns, after | 2,622 / 28,895 = 0.09 | 3,368 / 28,895 = 0.12 |
| 120 turns, after (both samples) | 2,622 / 18,383 = 0.14 | 3,368 / 18,383 = 0.18 |

The restyled count after the change is identical across samples and history lengths, so the ratio leaves more than five times headroom at 120 turns, while the pre-change behavior exceeds the budget fifty-fold. The case's first test replays these recorded values as its negative control.

## Alternatives considered

- Budget frame gaps or style milliseconds. Rejected for the gate: they need browser-runner calibration that does not exist yet, and they also include the transcript reflow at each new column width, which a resize legitimately pays. They remain diagnostics.
- Add the drag to the manual `apps/web` performance lane. Rejected: that lane runs only on request, and this regression must fail CI.
- Budget a viewport where the content width changes during the drag. Rejected: inherited width changes legitimately restyle descendants, so the count would measure the content width's consumers rather than the regression.

## Consequences

A regression that again publishes per-frame inputs to the transcript fails CI within one benchmark run, with no timing calibration. The case does not measure layout or paint cost, window resizing, the Conversation's own width handles, or a docked Session panel, whose end reserve can change the content inset during a drag. Chromium's element counting may change across browser versions; an upgrade that moves the counts re-records the calibration values above and in the negative control.
