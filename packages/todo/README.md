---
description: "The todo group map: the model-facing todo_write tool and opt-in stale-list reminders over the session log, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/todo

English | [中文](README.zh.md)

## Summary

The todo group gives agents a session-level task list to plan with: add tasks, mark them in progress, and check them off, with the same writer-authored list recoverable across turns and reopened sessions. It is one product package (`tool-todo`) that provides the `todo_write` whole-list operation, its durable event, and opt-in stale-list update reminders; the list belongs to the agent session that created it. Interactive hosts show the current-turn standing plan, while the group itself ships no UI.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-todo`](tool-todo/README.md) | Lets the agent maintain a session task list and optionally reminds the agent to reconcile an unchanged unfinished list | registers on `ctx.tools` and `ctx.sessionProjections` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Todo subsystem](../../docs/subsystems/todo.md) — the `todo/write` event payload, ownership rules, and `TodoItem`.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-todo) — the `todo_write` schema the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-tool-todo) — every accepted config field, including `reminder`.
- [todo_write tool Agent Note](../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) — the original design and its alternatives.
- [Todo update reminder Agent Note](../../.agents/notes/implemented/feature/2026-08-27-todo-update-reminder.md) — reminder scheduling, opt-in default, and package ownership rationale.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
