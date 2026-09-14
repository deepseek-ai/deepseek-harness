# Agent Note: Keep the room reading independent of hidden split controls

Status: implemented

English | [中文](2026-09-08-stable-room-reading-under-hidden-split-controls.zh.md)

## Problem

The dockkit room rule measures each pane's tab strip after every commit to decide whether an equal split leaves two working halves. With `hideSplitWhenBlocked`, a width-blocked pane unmounts its split control — and the unmount changes the very strip the rule measured: the strip sheds the control's 28px box plus its 4px gap, the fixed part shrinks, and the same pane reads as fitting again. Remounting the control reverses the reading. Across a roughly 32px band of pane widths the two states alternate inside nested layout effects until React stops the update loop (error #185); the slot runtime catches the crash and unmounts the Sidebar's entry while the column still records itself expanded, so neither the panel nor the header's collapsed-only expand button renders. A grip drag on a squeezed viewport sweeps the panel through that band, which presented as the whole sidebar vanishing with no way back in.

## Decision

When the embedder hides blocked split controls, the room rule leaves the split control's footprint out of the strip's fixed part unconditionally, so the reading is the same whether the control is currently mounted or not. [`measurePaneFits`](../../../../packages/client/ui-dockkit/src/components/measure.ts) takes the embedder's `hideSplitWhenBlocked` choice, measures the rendered control's box plus the strip's column gap (`splitControlFootprint`), and passes it as [`PaneMeasure.splitControlWidth`](../../../../packages/client/ui-dockkit/src/engine/geometry.ts), which `halvesFit` subtracts from the fixed part. Excluding the footprint is also correct on its own terms: a half too narrow to split would hide its own control, so the footprint is not part of what a half must carry. Embedders that render blocked controls disabled pass nothing and keep the control in the fixed part, as before.

## Alternatives considered

**Hide only budget-blocked controls, render width-blocked ones disabled.** This is what the code did before `hideSplitAtCapacity` widened into `hideSplitWhenBlocked`: the budget is state-driven and cannot feed back through the measurement. It avoids the loop but forfeits the Sidebar's requested presentation — no disabled split control on panes that cannot split.

**Debounce or freeze re-measurement during oscillation.** Damping hides the instability instead of removing it: the reading would still depend on the control's visibility, settle on an arbitrary one of the two states, and flip on the next resize.

**Measure the control's footprint from a constant.** A hardcoded 32px drifts from the stylesheet; measuring the rendered control and the strip's real `column-gap` keeps the subtraction equal to what the strip actually sheds, which is the exact condition for a stable reading.

## Consequences

The room reading is a fixed point under control visibility, so `hideSplitWhenBlocked` embedders get hidden controls without feedback. Panes near the boundary now read as splittable slightly earlier than a disabled-control embedder would report, because the half being asked about would not carry the control. A [dockkit regression test](../../../../packages/client/ui-dockkit/tests/components.client.spec.tsx) emulates the strip shedding the control's footprint and fails with React's update-depth error on the unfixed code; a [Sidebar browser case](../../../../apps/web/tests/sidebar-right.e2e.ts) drags the panel grip past both clamps on a squeezed viewport and asserts the panel, its grip, and a clean console survive, because the crash surfaces only as a console error the scaffold tripwire does not watch.
