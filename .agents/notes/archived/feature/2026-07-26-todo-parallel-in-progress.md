# Agent Note: Allow several `in_progress` todos at once

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-todo-parallel-in-progress.zh.md)

## Problem

The [original `todo_write` design](2026-06-29-todo-write-tool.md) enforced at most one `in_progress` task per list, both in `execute` and in the durable-log invariant. That invariant assumes sequential work, but the harness runs genuinely parallel work — concurrent subagents through the delegation tool, background bash commands, workflow fan-out — and a list that can name only one active task cannot represent it. The model was forced to either mislabel parallel tasks as `pending` or merge them into one vague item, and the UI progress checklist under-reported what was actually running.

## Decision

Make the single-`in_progress` cap a deployment policy instead of a fixed rule, requiring every composition to choose:

- `packages/todo/tool-todo/src/index.ts` gains the required `Config.allowParallelInProgress` field. At `true`, `execute` accepts any number of active items and the description instructs the model to mark every actively-worked task — several during parallel work, one for sequential work — keeping at least one while work remains. At `false`, the description asks for exactly one and `execute` rejects a call marking more.
- The durable-log invariant in `packages/todo/tool-todo/src/invariant.ts` no longer rejects snapshots with several active items, and does not follow the config, so previously-persisted logs are unaffected and parallel snapshots replay cleanly under either policy.

The remaining coded invariants are unchanged: non-empty trimmed unique `content`, valid status enum. This supersedes the "at most one active" clause of the [original design's validation decision](2026-06-29-todo-write-tool.md); the rest of that Agent Note (whole-list replace, log-backed state, single owner) stands.

## Why guidance, not a parallelism-aware invariant

A coded invariant can only see the list, not the runtime: whether two `in_progress` items are legitimate depends on whether work is actually running concurrently, which the tool cannot observe. Enforcing a cap was therefore wrong in exactly the cases parallelism made it matter, and any replacement (for example, capping active items at the live subagent count) would couple the tool to runtimes it deliberately knows nothing about. The discipline of matching `in_progress` marks to genuinely concurrent work moves to the tool description, the same place ordering and list freshness already live.

## The policy is a deployment choice

Whether concurrent active tasks are legitimate depends on runtime concurrency the tool cannot observe — but whether a deployment's agents ever run work concurrently is knowable at composition time. That makes the policy a required `Config` field rather than a constant or default: every cordis.yml composition sets `allowParallelInProgress` deliberately, choosing `true` for agents that may fan out work or `false` for the single-active discipline.

The flag moves the model-facing instruction and the accepted input together. Splitting them would be the bug: a description asking for one active task while `execute` accepts several teaches the model a rule the tool does not hold, and the reverse rejects calls the description invited. Only the active-status clause of the description varies, because that is the only instruction the policy changes.

The durable-log invariant deliberately does NOT follow the flag. A log written while parallel work was allowed must still replay after a deployment tightens the policy, so tying `invariant.ts` to the current config would reject history that was valid when it was written. The invariant stays silent on the active count; the tool is where the policy applies, at the moment of the write.

## Alternatives considered

- **Keep the cap and add an explicit parallel opt-in flag** — an extra argument on every call to serve the common case; the flag would be noise for sequential work and still unverifiable.
- **Cap active items at a configured maximum** — any fixed number is arbitrary. This is why the config field is a boolean policy switch and not a count: "may several tasks be active" is a property of the deployment, while "at most N" invents a threshold nothing can justify.
- **Hardcode the parallel policy** — the first revision of this change did, which is what made `allowParallelInProgress` necessary: a deployment running strictly sequential agents had no way back to the discipline it wanted.

## The display surfaces are part of the change

Lifting the cap makes a list shape reachable that no renderer had ever received, so this change builds on the [web todo display](2026-07-23-web-todo-display.md) rather than landing beside it: both change `tool-todo`, and the GUI is where a parallel plan becomes visible. Two web sites derived their one-line summary with `todos.find(t => t.status === 'in_progress')` — the collapsed plan-strip header and the `todo_write` row — and under the old cap that `find` was total, since at most one item could match. With several active it silently dropped every active item but the first: a four-item plan with three running tasks collapsed to the name of one, and the row read `1/4 已完成 · <one task>` while two others were in flight. The expanded list was always correct (it maps every item), which is why neither change's tests caught it — only the collapsed header and the row lost information. The panel redesign replaced the collapsed header's named hint with `·`-joined per-status counts (localized, `1 completed · 2 in progress · 1 pending`, zero-count segments omitted), which reports parallel work correctly and needs no name to truncate; the row is the one site this change still had to fix.

The row takes `planSummary` in `toolviews/plan-summary.ts`. It names the first active item and counts the rest, so the row reports how many tasks are running instead of implying one. Naming every active item was rejected: the row is a single line, and an unbounded join would overflow it — the count degrades predictably where a list does not. The derivation sits inside the toolviews domain rather than in `contract/`, the inter-domain face: the panel computes its own counts inline and shares nothing with the row, so a contract module would declare a sharing relationship that no longer exists.

`planSummary` returns the name and the count as separate fields rather than one joined string, because the row truncates its summary with `overflow: hidden` / `text-overflow: ellipsis`. A count appended to the task name sits at the far end of the truncatable text, so exactly the narrow viewports and long task names that make the count informative are the ones that clip it away, leaving a parallel plan indistinguishable from a sequential one. The row therefore hands the count to the shared `ToolRow` as `summarySuffix`, a non-shrinking slot beside the ellipsized summary text; a pre-joined string could not express that split, and pushing the count in front of the name was rejected because the task name is what the reader is looking for first.

`summarySuffix` is a slot on `ToolRow` rather than markup owned by the todo row: every toolview renders through that shared component, whose `summary` is a plain ellipsized string with no place for a fragment that must survive the clip. Sitting outside the `.summary` rule, the suffix repeats that rule's `font-size` and `line-height` — the web shell leaves body text at the browser default rather than the row's 14px, so an unstyled span renders visibly larger than the text beside it on a 24px row. An error row drops the suffix, because its collapsed summary is the failure line rather than anything derived from the call args.

## Deferred

Two known gaps are deferred. The `summarySuffix` span carries no accessible name, so a screen reader reads the count without its noun (`… 实现 fixture 样本 +1`); naming it introduces localized copy with its own test contract, which belongs to an accessibility pass over the whole `ToolRow` summary line rather than to one row. And when the *first* active item's content is unusable — missing, mistyped, or blank once trimmed — the row drops the active clause and the count with it, so a parallel plan renders as bare counts; skipping forward to the first usable active item was rejected because call args are an explicitly unvalidated boundary where model order is the only ordering the row can honour, and dropping the unusable clause alone keeps the `done`/`total` counts, which are trustworthy regardless.

## Consequences

A todo list can now faithfully mirror parallel execution, and every surface renders several active markers at once: the plan strip's header counts the active items, and the row needed the derivation above. A composition that sets `allowParallelInProgress: true` no longer rejects a formerly-invalid snapshot shape; one that sets `false` keeps the old rejection, and the durable-log invariant accepts both. The model-facing description changed, which re-recorded the tool-catalog page and every snapshot sidecar carrying the todo schema. No count is recorded here: the set grows with every pinning scenario that lands. The operative rule is that a branch changing the tool description must refresh whichever sidecars landed after it branched — including the numbered `tool-schemas.<n>.expected.json` files pinning a subagent class, whose schemas the parent scenario does not cover — and `pnpm run test:snapshot:refresh` does it keylessly over the whole corpus. The web fixture's todo sample now runs two items `in_progress`, so both fixture-driven surfaces render a parallel plan. `packages/client/ui-conversation/tests/todo-panel.client.spec.tsx` pins the row summary and the plan strip over src, the ACP `todo-write` scenario records a three-todo plan with two active, and `apps/web/tests/todo-row.expected.e2e.ts` pins both surfaces in the assembled application — booted from the built `packages/client/*/lib/client.js` bundles, so it is the one place the keyed registration and the bundled wiring are under test. That last file records `summary`, `suffix`, and the strip's header as separate fields, so folding the `+N` count back into the summary string changes the expected output even though the concatenated text would read the same.
