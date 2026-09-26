---
description: "The deliverables group map: the Host plugins that record what a turn hands to the user, explicit file deliveries and observed workspace changes, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/deliverables

English | [中文](README.zh.md)

## Summary

The deliverables family records what a turn hands to the user as durable Session events that only clients read: the `present` tool declares final files the model delivered, and the workspace-changes recorder captures the files a turn changed with their line counts from git snapshots and whole-file captures, and serves each file's comparison. The Web [deliverables plugin](../client/ui-deliverables/README.md) renders both at the end of a turn. Choose this family for a product that shows delivered files and per-turn changes; `present` needs `ctx.tools` and `ctx.fs`, the recorder needs `ctx.subprocess` and a git executable.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-present`](tool-present/README.md) | Declares existing files as final deliverables through the `present` tool | registers on `ctx.tools` |
| [`workspace-changes`](workspace-changes/README.md) | Summarizes each top-level turn's changed files from git working-tree snapshots and whole-file captures, and serves their comparisons | provides `ctx.workspaceChanges`; listens to `session/event`, appends `workspace/changes` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Deliverables subsystem](../../docs/subsystems/deliverables.md) — the `PresentedFile` and `WorkspaceChangesSummary` vocabulary, the two durable events, and the summary service.
- [Web deliverables](../client/ui-deliverables/README.md) — the turn-tail cards and file mentions that render these events.
- [Present declares workspace source files](../../.agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.md) — the delivery decision.
- [Turn changed-files card](../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — the snapshot design and coverage rules.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
