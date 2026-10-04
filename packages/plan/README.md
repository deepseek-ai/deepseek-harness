---
description: "Package map for the plan group: the plan-mode feature that guides the agent to explore and design before executing, for users and maintainers navigating the group."
kind: "package-group"
---

# plan/ — plan collaboration state

English | [中文](README.zh.md)

## Summary

The `plan/` group provides plan mode: while it is active, the agent explores and designs before executing, guided by instructions the deployment writes, and presents the finished plan for your approval before carrying it out. You can enter and leave plan mode with the `/plan` command and approve the plan or send the agent back to keep planning. Plan mode guides rather than restricts: every tool stays available, and limits such as sandbox mode and approval prompts are configured separately. The group contains one package, `plan-mode`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package provides the whole plan-mode feature; the subsystem reference owns the exhaustive contracts.

| Package | Role | ctx key |
|---|---|---|
| [`plan-mode/`](plan-mode/README.md) | Provides plan mode: `/plan` enters and leaves it, deployment guidance steers the agent while planning, and `exit_plan_mode` presents the finished plan for your review | `ctx.planMode` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then read the design note for the decisions.

- [Plan mode subsystem reference](../../docs/subsystems/plan.md) — how plan mode works, its configuration, and the exit tool's behavior.
- [Plan-specific collaboration state](plan-mode/README.md) — the design decision behind plan mode.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
