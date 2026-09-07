# Agent Note: Todo plan strip clears on the next turn

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-todo-plan-clears-on-next-turn.zh.md)

## Problem

`todo_write` stores whole-list snapshots on the session log, and interactive hosts render the latest list as a plan strip (web TodoPanel via the `todos` projection, TUI Plan panel). After a turn finished, that strip stayed on screen into the next user turn — a completed or abandoned checklist from the previous task. Readers treat the strip as "what this turn is doing," so a stale list across the turn boundary is the wrong product lifetime. The [web todo display](2026-07-23-web-todo-display.md) and [`todo_write` tool](2026-06-29-todo-write-tool.md) notes still own event-sourcing and the two render surfaces; they described the standing plan as lasting for the whole session until the next write.

## Decision

The standing plan is the latest `todo/write` that is not followed by a later `turn/start`. `turn/end` keeps the list visible so the finished checklist remains while the user reads the answer; the next `turn/start` clears it until the model writes again.

### Host projection (web)

`dsh-tool-todo`'s `todos` projection unit folds the rule: `apply` takes the whole list from each `todo/write` and returns `null` on each `turn/start` (`stateVersion` 2). Session Controller serves that value on the history tail `projections` block and pushes `session/projection` frames; the web dock reads it through `useProjection('todos')`. The keyless fixture mirrors the same fold for assembled snapshots.

### TUI live path

The former TUI's `renderEvent` switch cleared its local plan panel on `turn/start` and replaced it on `todo/write`, with its rebuild path resetting the panel before replay so cold resume converged on the same rule; that package has since been removed ([remove TUI package](../simplification/2026-08-04-remove-tui-package.md)).

## Alternatives considered

- **Clear on `turn/end`** — hides the checklist while the user is still reading the just-finished answer; the strip's job at that moment is the completed plan, not an empty dock.
- **Clear only when every item is `completed`** — leaves abandoned or partial plans across turns; the strip would still show another task's work.
- **Append an empty `todo/write` on turn start** — mutates the log for a UI lifetime rule and invents a write the model never authored.

## Consequences

The host projection and the TUI panel share one lifetime rule; reopening a session restores a plan only when no later turn has started. Partial supersession of the session-long standing-plan wording in [web todo display](2026-07-23-web-todo-display.md) and [`todo_write` tool](2026-06-29-todo-write-tool.md): event-sourcing, last-write-wins replacement, and the two render surfaces stay there; this note owns turn-boundary clearance. Coverage: tool-todo projection specs for turn/start clear + turn/end keep, fixture push-frame clearance for the assembled web snapshot, plus the TUI snapshot that starts the next turn and pins the strip gone.
