# Agent Note: Right Sidebar drag restyle budget

Status: implemented

English | [中文](2026-11-20-rightbar-drag-restyle-budget.zh.md)

## Problem

Dragging the right Sidebar beside a long transcript stalled for hundreds of milliseconds per frame. The Conversation body published measured widths as unregistered, inherited custom properties on an ancestor of the whole transcript, so every frame restyled every transcript element, even when the resolved content width did not change; later resize observers that read geometry forced that work synchronously. Existing browser benchmarks open, page, and stream a long Session, but none resizes it, so the regression had no gate.

## Decision

The [right Sidebar drag benchmark](../../../../benchmarks/rightbar-drag-browser/README.md) joins the serial browser inventory. It loads a 120-turn synthetic Session completely, opens the right Sidebar, and drags its handle 40 trusted 8px mouse steps outward and back in a 1680×1000 viewport, in two fresh scaffold worlds and browsers. At that width the transcript column stays below the 680px content-width floor, and each drag asserts it, so the drag changes the column but not the resolved content width.

The restyle ratio is a dimensionless count: the elements reported by every `UpdateLayoutTree` trace event during one drag, divided by the page's element count. The 1680px case budgets the upper median per direction at 1. A second case keeps the rendered column at 720px and crosses the hidden Session panel's reserve-room threshold. It budgets each direction at 0.10: a single transcript-wide recalculation matters even if it happens on only one of the 40 steps. Neither count scales with CPU speed, and no wall-clock endpoint is budgeted or passed to the scaling report.

## Calibration

Local Linux x64 Chromium samples, 40-step drags:

| Workload | Widen | Narrow |
|---|---:|---:|
| 200 turns, before the width axis change | 1,479,947 / 28,895 = 51.2 | 1,909,568 / 28,895 = 66.1 |
| 200 turns, after | 2,622 / 28,895 = 0.09 | 3,368 / 28,895 = 0.12 |
| 120 turns, after (both samples) | 2,622 / 18,383 = 0.14 | 3,368 / 18,383 = 0.18 |

The restyled count after the change is identical across samples and history lengths, so the ratio leaves more than five times headroom at 120 turns, while the pre-change behavior exceeds the budget fifty-fold. The case's first test replays these recorded values as its negative control.

In the 120-turn Chromium trace, 40 `Layout` events per direction ran inside script before the geometry-read fix and none afterwards. A second budget allows 20 script-nested layouts per drag: it rejects repeated synchronous layout without requiring every callback to be layout-free or penalizing normal reflow after script returns.

At 2560px with 120 turns and a 720px rendered column, the required benchmark traces the full drag against built Web artifacts, including the press and release. Before the fix, widening restyled 18,239 / 18,428 = 0.98974, failing the 0.10 budget. A diagnostic trace attributed 14,911 restyled elements to a single reserve-room flip. After the fix, widening restyled 380 / 18,428 = 0.02062 and narrowing restyled 379 / 18,428 = 0.02057. The Sidebar moved 80px each way, the column stayed at 720px, and the probe switched in both directions. The budget allows 1,842 restyles: nearly five times either passing count, but less than 40 updates of 82 elements even without the single large recalculation.

The fixed-column peak has an absolute budget of 512 elements in any one completed `UpdateLayoutTree` event. In a 120-turn local widening trace, 40 passes visited one element each, 40 visited three each, two visited four each, and one visited 212 (380 total). Restoring only inheritance of the dock probe's room value into the message flow in the same browser workload left the small buckets unchanged but replaced the 212-element peak with 14,911. The budget leaves more than twice the healthy peak without growing with the size of unrelated page content. A separate control with 600 total visits passes the cumulative budget either way: 200 passes of three pass the peak budget, one pass of 600 fails it.

## Alternatives considered

- Budget frame gaps or style milliseconds. Rejected for the gate: they need browser-runner calibration that does not exist yet, and they also include the transcript reflow at each new column width, which a resize legitimately pays. They remain diagnostics.
- Add the drag to the manual `apps/web` performance lane. Rejected: that lane runs only on request, and this regression must fail CI.
- Budget a viewport where the content width changes during the drag. Rejected: inherited width changes legitimately restyle descendants, so the count would measure the content width's consumers rather than the regression.

## Consequences

A regression that again publishes per-frame inputs to the transcript fails CI within one benchmark run, with no timing calibration. The case does not cap total layout or paint cost, nor does it cover window resizing, the Conversation's own width handles, or a docked Session panel, whose end reserve can change the content inset during a drag. Chromium's element counting may change across browser versions; an upgrade that moves the counts re-records the calibration values above and in the negative control.
