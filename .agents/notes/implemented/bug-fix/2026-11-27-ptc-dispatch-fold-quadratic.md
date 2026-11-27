# Agent Note: Linear PTC dispatch folding

Status: implemented

English | [中文](2026-11-27-ptc-dispatch-fold-quadratic.zh.md)

## Problem

Opening a real computer-use Session in the Web GUI took seconds before the conversation appeared. The Session JSONL expands to 50,294 events, and 49,258 of them are nested PTC dispatch events: 24,629 `tool/ptc-dispatch-start` and 24,629 `tool/ptc-dispatch`, with up to 20,480 subcalls under one parent call. The Client requests `maxMessages: 500` with `turnWindow { minMessages: 50, minTurns: 2 }`, so it intends to read a bounded tail; the resulting window held 50,260 events, almost the whole log. The [Chat Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) folded that window in 8,950 ms. Its `updateDispatch` found the child with `findIndex`, copied the parent's whole child array, and copied every parent edge into a new `Map` for each dispatch event, so one parent with n children cost O(n²).

The [Trajectory Tool Definition](../../../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts) had the same structure. For each dispatch event its `updateDispatch` searched the parent's child-id list with `indexOf` and copied the call map; on first attachment it also copied the child map, the parent map, and the parent's child-id list. Each root `tool/result` copied the call map again. The [Web composition](../../../../packages/bundle/web-app/cordis.patch.yml) enables ui-trajectory by default, and the Assembler updates every registered Definition whether or not its target is active, so this cost applied to every Chat open, not only to the Trajectory tab.

## Decision

Both Definitions keep a `DispatchTree` in their State and mutate it in place. Dispatch updates, and the Trajectory root-result update, return the same State object; `start()` still creates a new State, so a replay starts from a fresh tree. The [Assembler update rule](../architecture/2026-08-09-client-conversation-node-assembly.md) permits returning the mutated State, because the Assembler does not decide publication by State reference. Returning the same State follows the approach of #9400 by imccyu.

The Chat tree is `Map<parentCallId, Map<subCallId, ToolCallBlock>>` for children in first-attachment order, plus `Map<subCallId, parentCallId>` for cycle and depth checks. `updateDispatch` inserts or replaces the child in its parent's inner map, so replacement is idempotent, first attachment fixes the order, and one dispatch costs O(1) map work. `projectBlock` materializes each parent's inner-map values into a fresh array when it publishes.

The Trajectory tree keeps that Definition's existing indexes: one call map keyed by call id for the root and every accepted child, child-id lists in first-attachment order, and the parent map. Chat uses inner maps because its State has no call map keyed by id, and a repeated settle must find the child under its parent in constant time. Trajectory keeps its single call map because that map already provides the lookup, and keeping it preserves the existing acceptance and replacement behavior for every id, including a subcall id equal to the root id. Because `acceptsEdge` gives each child at most one parent, an edge exists exactly when the parent map names that parent, which replaces the `indexOf` scan without changing which events are accepted. A dispatch writes the call map and, on first attachment, appends one id and one parent entry; the root result writes the root entry in place. `projectCall` still builds a new projected tree on every publication.

Published Tool call blocks in both targets carry their own arrays and never alias the dispatch trees, so downstream code keeps its immutable value semantics. Every event is folded once in logical `seq` order.

The [conversation-fold benchmark](../../../../benchmarks/conversation-fold/conversation-fold.bench.client.ts) case `conversation-fold/ptc-dispatch-fan-out` runs the `ptc` entry point of its [worker](../../../../benchmarks/conversation-fold/conversation-fold.worker.client.ts). The worker registers the Trajectory Tool Definition and Trajectory view beside the Chat Definitions, matching the default Web composition. The case synthesizes two root calls with 10,000 settled nested dispatches each: one start and one settle event per subcall, 40,004 events in total. It folds the window three times with Chat active and three times with Trajectory active, keeping the fastest sample of each. It asserts that each target's snapshot contains 20,000 children and that every child is a settled tool result. Both targets share one 100 ms reference-machine expectation, which `ciTimeBudget(100)` turns into 250 ms at the shared 2× CI time scale and 1.25× headroom. The [frontend performance budgets](../testing/2026-09-06-frontend-performance-budgets.md) note lists the case among the conversation-fold benchmarks.

## Calibration

All measurements use the compiled benchmark worker under plain Node on macOS arm64 with Node 26.0.0. Before values come from the same worker with both copy-per-dispatch implementations restored from master; they are negative controls, not a historical checkout. Before rows are one sample; after rows are the fastest of three.

| Nested dispatches under one parent | Before, Chat active | Before, Trajectory active | After, Chat active | After, Trajectory active |
|---|---:|---:|---:|---:|
| 1,000 | 97 ms | 89 ms | 4 ms | 3 ms |
| 2,000 | 372 ms | 352 ms | 8 ms | 7 ms |
| 4,000 | 1,511 ms | 1,516 ms | 17 ms | 12 ms |
| 8,000 | 6,680 ms | 6,327 ms | 32 ms | 22 ms |
| 2 × 10,000 (benchmark shape) | 29,176 ms | 22,483 ms | 58–63 ms | 53–59 ms |

Before the change each doubling roughly quadruples the time; after it the time doubles. Restoring only one Definition still makes both targets quadratic, because the Assembler updates both. On the benchmark shape, restoring only the Chat implementation measured 9,073 ms with Chat active and 8,035 ms with Trajectory active in the required case, which failed its 250 ms budget. Restoring only the Trajectory implementation measured 12,078 ms and 11,496 ms in one worker sample, and the required case exceeded its 60-second worker deadline.

On the real 50,260-event window, the complete Chat fold fell from 8,950 ms to 112 ms. Separate phase measurements on the same window recorded match/update at 9,365 ms → 102 ms and publication at 17 ms → 10 ms. Those numbers were measured with the Vitest source harness before the Trajectory change.

## Alternatives considered

- **Keep the array and index it by child id.** A per-parent `Map<subCallId, index>` would remove `findIndex`, but every dispatch would still copy the growing array and all parent edges, so the quadratic copying remains.
- **Append to arrays in place and copy once at publication in Chat.** This also removes the per-event copy, but Chat's `updateDispatch` must still reject cycles and depth overflow during the fold; arrays plus a parent map would duplicate the index that the inner map provides, and a repeated settle would need a scan or a second index.
- **Give Trajectory the Chat inner-map layout or a shared module.** Rejected because the two Definitions are intentionally independent, and Trajectory's single call map preserves its existing acceptance and replacement behavior for every id.
- **Cache Trajectory projections as Chat does.** Not part of this change: the cold fold publishes each root once, and per-publication rebuilding is the existing Trajectory behavior.
- **Fold or render only a bounded prefix of a PTC run.** Rejected because one turn can legitimately hold the whole run, a parent's nested calls have no message boundary to page at, and hiding children changes the user-visible tool tree rather than removing the fold cost.

## Consequences

One dispatch now costs constant map work in both Definitions, so a Session with a wide PTC fan-out opens in proportion to its event count. Each tree retains one entry per call and child edge, the same order of memory the copied maps and arrays used. Publication still materializes arrays per parent, so each published tree is an immutable value. The Chat projection cache reuses unchanged blocks; Trajectory rebuilds its projected tree on each publication.

The case fails CI within one benchmark run when either per-event copy returns. It covers settled nested dispatches under two roots in a cold fold; it does not cover live appends that republish after each dispatch, dispatch events still streaming, error results, or a tree near the 256-call depth ceiling. A wall-clock budget still needs recalibration on a new reference machine, and the 250 ms CI budget follows the shared scale rather than a hosted measurement of this case.

The existing 1,066 ui-chat tests, including [turns and tool-call-tree](../../../../packages/client/ui-chat/tests/tool-call-tree.client.spec.ts), and the existing ui-trajectory tests pass unchanged. [Trajectory conversation Definition tests](../../../../packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts) add cases for attachment order, repeated starts, cycles, reparenting, adopted detached subtrees, and roots rebuilt from their result; these cases also pass against the copy-per-dispatch implementation. Both Definition files are outside the per-file coverage gate through the `vitest.config.ts` exclusions for ui-chat conversation nodes and ui-trajectory sources; measured with their package tests, `tool.ts` reaches 98.56% of lines and `trajectory-tool-definition.ts` 97.84%, and the remaining gaps are defensive and non-dispatch paths. The real Session log was used only for local diagnosis; no log content entered the repository or a fixture.
