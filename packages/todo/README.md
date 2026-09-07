---
description: "The todo group map: the model-facing todo_write tool over the session log, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/todo

English | [中文](README.zh.md)

## Summary

The todo group gives agents a session-level task list to plan with: add tasks, mark them in progress, and check them off, with the same list persisting across turns and reopened sessions. It is one product package that provides the `todo_write` tool; the list belongs to the agent session that created it, and each update replaces the whole list. Interactive hosts show the standing plan from the list, while the group itself ships no UI.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-todo`](tool-todo/README.md) | Lets the agent maintain a session task list: plan tasks, update status, and track progress | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Todo subsystem](../../docs/subsystems/todo.md) — the `todo/write` event payload, ownership rules, and `TodoItem`.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-todo) — the `todo_write` schema the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-tool-todo) — every accepted config field.
- [todo_write tool Agent Note](../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) — the original design and its alternatives.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
