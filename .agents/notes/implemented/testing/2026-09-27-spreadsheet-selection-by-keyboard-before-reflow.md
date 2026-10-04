# Agent Note: Web lane moves spreadsheet selections by keyboard before reflow assertions

Status: implemented

English | [中文](2026-09-27-spreadsheet-selection-by-keyboard-before-reflow.zh.md)

## Problem

[document-preview.e2e.ts](../../../../apps/web/tests/document-preview.e2e.ts) opens `meeting.xlsx`, clicks the sheet overlay at `{ x: 60, y: 40 }` to select `A1`, then widens and narrows the sidebar four times and asserts after each reflow that the name box still reads `A1`. Ten of the eleven `CI master` runs of the serial self-hosted Linux lane between 2026-09-24 and 2026-09-27 failed one or both locale cases of that scenario with `expected 'B1' to be 'A1'` at the first reflow, and hosted `node 24 / snapshots and artifacts` runs failed the same way (runs 36110572677 and 36213089675). The failure is not locale-bound: en-US failed alone in four master runs, both locales in three, zh-CN alone in three. Polling the read (#5243) changed nothing because `B1` is the committed selection, not a stale sample.

`A1` is the workbook's initial selection, so the polls that follow the click are satisfied before the click commits and never verify what the click selected. FortuneSheet's `SheetOverlay` handles the press as `setContext(draft => handleCellAreaMouseDown(draft, globalCache, nativeEvent, cellInput, cellArea, …))`, and `handleCellAreaMouseDown` resolves the cell from `cellArea.getBoundingClientRect()` and the event's page coordinates at the moment the updater runs. React runs `useState` updaters during render and runs them again when the hook queue holds a lower-priority update ahead of them; the freshly mounted workbook still has such updates pending, and Playwright precedes the press with a `mousemove` whose FortuneSheet handler is a continuous-priority update on the same state. An instrumented verbatim copy of the scenario on the Blacksmith runner recorded four executions of `handleCellAreaMouseDown` for the one click: two before the click returned reading `left=969.5`, and two after the scenario had already set the panel to `1000px`, reading `left=725.5`. The stored pointer x of 985 then resolves to 259.5 inside the grid, and because the meeting sheet has two columns `colLocation` clamps it to the last one: `B1`. On a machine that commits the workbook's initial selection normalization before the click, the same point lies on A1's own selection box, whose `onMouseDown` stops propagation; the click then selects nothing, no geometry-bound updater is queued, and the scenario passes without having tested the click.

## Decision

The meeting-sheet step selects by keyboard. The scenario focuses the sheet overlay (`tabindex="-1"`), asserts the focus landed, presses `ArrowRight` and asserts `B1` with an empty formula bar, then presses `ArrowLeft` and asserts `A1` with `会议纪要`, and only then starts the reflow loop. `handleArrowKey` → `moveHighlightCell` computes the target from committed state — the current selection and `visibledatacolumn` — so a re-executed updater yields the same cell whatever the grid's geometry is by then, and the two moves make the interaction observable because `B1` differs from the initial selection. The reflow loop, its `A1` assertion, the sheet-tab scroll-control counts, and the canvas identity check are unchanged.

The budget-sheet click at the start of the scenario stays a pointer click: it targets a cell other than the initial selection, its result is verified by the `46281` formula read, and keyboard, clipboard, and layout reads separate it from the first reflow by far more than one deferred render. The `values.csv` click followed by a narrowing stays too: a re-execution against the narrowed grid resolves a negative x, which `colLocation` clamps to column A, the same cell.

## Alternatives considered

**Poll the name box after each reflow.** #5243 did this. The re-executed updater's result is the final committed state, so the poll observes `B1` for its whole budget; there is no later state to wait for.

**Wait for the selection box to render before clicking.** That restores the passing path in which the click lands on A1's own drag handle and selects nothing, so the assertions would verify the initial selection rather than an interaction. Clicking a cell other than the initial selection instead keeps the geometry-bound updater and its re-execution window open across the reflow that follows.

**Wait for the renderer to go idle before the first reflow.** No product state names "React has no re-execution pending"; an idle or fixed wait sized to the runner is the flake-masking wait [dsh-ci-test-reliability](../../../skills/dsh-ci-test-reliability/SKILL.md) rejects.

**Extend the `@fortune-sheet/react` patch to resolve the cell outside the updater.** `handleCellAreaMouseDown` lives in `@fortune-sheet/core`, and the window a user would need to hit is a pointer press and a sidebar reflow inside one deferred render. It stays an upstream concern; the product change is out of this test fix.

## Verification

The instrumented verbatim copy of the shipped scenario, run on the hosted Linux lane of PR #5291 while it was a draft, reproduced `expected 'B1' to be 'A1'` at the first reflow in 7 of 38 runs across three lane runs (2 of 6, 1 of 6, 4 of 20). Every failure recorded `mousedown` targeting `#luckysheet-sheettable_0` rather than the drag handle and the `B1` commit preceding the deferred `cellInput.focus()` that only the press updater schedules; the five failures in the two lane runs that also hooked the cell area's `getBoundingClientRect` all carried the four-execution signature above. The keyboard-driven copy ran in those same two lane runs and passed 26 of 26. Locally, `Emulation.setCPUThrottlingRate` at 20× makes the click reach the cell area and records three executions of `handleCellAreaMouseDown` per click; the keyboard-driven copy passes 6 of 6 under that throttle and 6 of 6 with React's scheduler wake-ups deferred by 200 ms.

`env -u TSX_TSCONFIG_PATH DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/document-preview.e2e.ts -t "fills the spreadsheet pane"` passed both locale cases in 10 of 10 local repetitions, and the whole file passed its 6 cases in 2 of 3 local runs; the third failed the unrelated `Coding Tools` switch poll at `:849` while documentation gates ran concurrently, with the failure screenshot showing the switch on.

## Consequences

The scenario verifies a keyboard-made selection surviving sidebar reflows and no longer depends on where React's deferred render lands relative to the reflow. A pointer click in this lane remains valid when its target differs from the current selection and its effect is asserted before any layout change, or when a re-execution against the changed layout provably resolves the same cell; a click whose result feeds a reflow assertion within a few round trips does not. FortuneSheet's geometry-bound updater is unchanged, so a real pointer press followed within one deferred render by a sidebar reflow can still move the selection in the product.
