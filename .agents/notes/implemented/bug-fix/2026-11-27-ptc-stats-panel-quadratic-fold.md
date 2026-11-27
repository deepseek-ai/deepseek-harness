# Agent Note: Linear Statistics folding for a wide PTC run

Status: implemented

English | [中文](2026-11-27-ptc-stats-panel-quadratic-fold.zh.md)

## Problem

The Statistics view folds every Session window into one node per step and one node per Code-Mode root call. A single PTC `run_code` call can dispatch tens of thousands of nested subcalls, and the [fold](../../../../packages/experimental/client-ui-stats/src/client/stats-fold.ts) copied the two collections that grow with that count on every event: `starts` in `tool/ptc-dispatch-start`, and `calls` in `tool/ptc-dispatch`. One root call with n subcalls therefore cost O(n²) shallow copies, and the fold alone took seconds before the panel could render.

The [Chat and Trajectory Tool Definitions](2026-11-27-ptc-dispatch-fold-quadratic.md) already fold their tool trees linearly; this package folds its own per-step records, so neither Definition's fix covered it.

Publication carried the same cost. [`codeModeDefinition.buildViewNode`](../../../../packages/experimental/client-ui-stats/src/client/stats-definition.ts) called `stepMetrics(state)` for every dispatch, which materializes and sorts the complete call index to produce a node that lists at most `CALL_LIMIT` (12) rows. The Definition declared no publication cadence, so the assembler flushed and rebuilt the target snapshot once per dispatch event.

## Decision

The four fold collections of one Context are `Map`s it owns and mutates in place: `pending` and `tools` for the tool tally, `calls` for recorded calls, and `starts` for dispatch start times. `update()` returns the same State object, which the [Assembler update rule](../architecture/2026-08-09-client-conversation-node-assembly.md) permits; `start()` still creates a new State, so a replay folds from empty collections. A dispatch start is deleted once its settle event reads it, because the pair exists only to measure one duration.

The call list no longer sorts the index. A Context receives its matches in ascending `seq`, and a call id is created once by the event that first records it, so insertion order is the order the table lists. `callList` walks the index and stops at `CALL_LIMIT` rows, applying the per-step text budget on the way.

The Code-Mode node now materializes that bounded prefix directly through `innerCalls`, which also drops the nested `run_code` calls the step row replaces with their real subcalls; `stepMetrics` no longer runs for a publication that discards all of its other fields. While the visible prefix, the anchor, and the Location stay the same, the Definition republishes the node object it returned before, and the target builder keeps its current snapshot when every upserted node is the one it already holds. That reuse reads the node the Assembler keeps for this Context, so it holds no cache of its own. Dispatch updates request `animation-frame` publication, and the Assembler materializes such a publication after three browser animation frames, so a wide run's dispatches coalesce into at most one publication every three frames.

A Code-Mode Context retains at most `CALL_LIMIT` call records. The event that settles a dispatch records it only when it can still reach the published prefix: a name the step row displays (`!isCodeMode(name)`) and an index shorter than `CALL_LIMIT`. Records already retained are replaced in place, so a repeated settle still updates its row. The counters that the dispatch branch itself maintains keep counting every dispatch: `tools`, which tallies each reported name, and `toolErrors`, which counts every failed one. The call-path counters `toolPairs`, `toolMs`, `toolOpen`, and `toolMissing` are written by the native `tool/call` and `tool/result` branches, which a Code-Mode Context never receives, so the retention bound cannot affect them. A step Context keeps every outer call: its own `tool/call` and `tool/result` path is untouched, and the retention rule sits on the dispatch branch that only a Code-Mode Context (or its fallback replay) reaches.

The bound is safe because nothing inside the Context consumes the dropped records: the published inner contribution and the step merge in [stats-aggregate](../../../../packages/experimental/client-ui-stats/src/client/stats-aggregate.ts) both consume only the retained first `CALL_LIMIT` displayable dispatches. A nested `run_code` dispatch therefore does not take one of those slots, which is why a run that dispatches a nested runner lists up to `CALL_LIMIT` real calls where it listed fewer before. What the bound gives up is a later "expand to every nested call" view: that view must derive a wider list from the Session events (or carry its own retention) instead of recovering it from this State.

## Calibration

All rows come from [the package diagnostic](../../../../packages/experimental/client-ui-stats/tests/ptc-dispatch-fold.perf.client.ts) on macOS arm64 with Node 24.18.0, run through `pnpm exec vitest run --config vitest.web.perf.config.ts packages/experimental/client-ui-stats/tests/ptc-dispatch-fold.perf.client.ts`. Before values restore the pre-change sources into the worktree (`git checkout <diagnostic commit> -- packages/experimental/client-ui-stats/src`); the workload, harness, and assertions are otherwise identical. `fold` folds the same events into one Code-Mode State, `publish` builds the node once, `republish` is the amortized cost of 50 further builds of the same Context, and `live` appends every event through the real `ConversationNodeAssembler` with the Statistics target active.

| Nested subcalls | Events | fold before | fold after | publish before | publish after | republish before | live before | live after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 2,006 | 101.6 ms | 0.9 ms | 0.311 ms | 0.058 ms | 0.068 ms | 244 ms | 9 ms |
| 3,000 | 6,006 | 1,035.9 ms | 0.8 ms | 0.476 ms | 0.002 ms | 0.507 ms | 4,371 ms | 13 ms |
| 10,000 | 20,006 | 13,945.5 ms | 2.2 ms | 2.507 ms | 0.004 ms | 2.139 ms | 63,434 ms | 35 ms |

Before the change each tripling of the dispatch count multiplied the fold by roughly 10 and 13; after it the fold stays under 3 ms for every size and the live window grows from 9 ms to 35 ms. The retained records stay at `CALL_LIMIT` (12) at every size, with no dispatch start left outstanding. The live window still publishes once per event in this harness because Node has no `requestAnimationFrame`, where `animation-frame` degrades to immediate; a browser instead materializes at most one publication every three frames.

## Alternatives considered

- **Keep the records and copy them once at publication.** Copying per publication still walks the growing record for every event that publishes, so the quadratic factor moves rather than disappears, and the Code-Mode node would have to rebuild the whole index to list 12 rows.
- **Give the Code-Mode Context a shared `DispatchTree` module.** The two preceding Definitions ([Chat](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) and [Trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts)) fold a tool tree with parents, children, and acceptance rules; this fold is a flat per-step list with no nesting, and a shared module would add a cross-package API for one consumer shape.
- **Keep the call list sorted by `seq`.** Sorting defends against an index whose insertion order differs from the event order, which the append-only fold cannot produce: a Context rejects a non-appended Match, and every record's `seq` is the sequence of the event that created it. The invariant is now a comment on `callList` instead of a per-publication `O(n log n)` cost.
- **Bound only the published prefix.** It fixes the publication cost but leaves the Context holding one record per nested subcall, so memory still tracks the run length; the fold's own per-event work is already constant either way.
- **Defer publication with `'none'` for dispatches.** It starves a live run of updates until some other event requests a flush, so a running `run_code` row would show no inner calls until it settles. `animation-frame` keeps the panel live and bounds the rate instead.
- **Cache the published node in the Context State.** The State is immutable surface for every other branch; a `WeakMap` keyed by the State, as the Chat Definition already does for projected blocks, keeps the cache out of the contract.

## Consequences

One dispatch costs constant index work, so a wide PTC run opens in proportion to its event count, and the panel no longer rebuilds the complete call list to show 12 rows. Each Code-Mode Context retains at most `CALL_LIMIT` calls and no settled start times; the run's true totals stay in the scalar counters and in the tools tally.

The existing `packages/experimental/client-ui-stats` suites pass with the same published output. Three assertions changed with the implementation they pin: the State collections are `Map`s, the call-order case now builds its index in `seq` order because the old fixture ordered keys against their `seq`, and the Code-Mode Definition now declares a publication cadence. Package tests add the retention bound, in-place replacement of a retained dispatch, same-node republication, and the snapshot rebuild skipped for unchanged nodes; the package's 17 source files keep 100% per-file coverage.

The diagnostic is threshold-free and stays outside every CI lane, so the linear behaviour is verified by running it rather than by a gate. It covers one root call with settled dispatches in a cold fold and a live append; it does not cover several roots in one step, dispatch events still streaming, error results, or the text budget shared across a full prefix.
