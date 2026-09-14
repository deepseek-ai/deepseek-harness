---
description: "The goal group map: one durable completion objective per session, with model tools, a human command, and automatic continuation, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/goal

English | [中文](README.zh.md)

## Summary

The goal group lets one agent session pursue a durable completion objective across restarts, resumes, and forks. Agents can create and update the objective, while people can inspect or control it directly with `/goal` without spending a model turn. An optional continuation package can keep active work moving through sequential Rounds. Each session has only one current goal, and that goal records completion state rather than scheduling work; automatic continuation must therefore be enabled separately.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`goal`](goal/README.md) | One durable goal per session: create, edit, pause, resume, complete, block, and clear | `ctx.goals` |
| [`tool-goal`](tool-goal/README.md) | Model tools `get_goal`, `create_goal`, `update_goal` | registers on `ctx.tools` |
| [`command-goal`](command-goal/README.md) | Human `/goal` command in UI command planes | registers on `ctx.commands` |
| [`goal-round-driver`](goal-round-driver/README.md) | Automatic continuation: turns an active goal into sequential Rounds | no service key |

-----

<a id="related-documentation"></a>
## Related documentation

- [Goal subsystem](../../docs/subsystems/goal.md) — goal types, durable `goal/change` events, and the generated service API.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-goal) — the three goal-tool schemas the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-goal) — every accepted config field of the goal service.
- [Goal domain Agent Note](../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) — the domain design and its decisions.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
