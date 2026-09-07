---
description: "The workspace group map: the persistent workspace entity family, durable directory records, and header-validated session membership, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/workspace

English | [中文](README.zh.md)

## Summary

The workspace group provides the durable project list behind a host UI: one product package, `workspace`, that names user directories as projects, keeps them in a stable order, and groups each project's sessions under it. With it, a UI can show a sidebar of projects with their sessions, hide a session from the grouping without deleting it, and remove a project — removal never deletes the folder or the session histories, which become ungrouped. The group is host-side only: no tools, prompts, or session events, so the model and the agent loop never see it. Use it when the product shows a persistent workspace or project surface; it needs a session store and a persistence backend alongside it.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`workspace`](workspace/README.md) | Provides named, ordered projects with the sessions that ran in each directory | `ctx.workspaceRegistry` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Workspace subsystem](../../docs/subsystems/workspace.md) — the authoritative feature contract for projects and their sessions.
- [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the storage design behind project records.
- [Workspace UI product-flow Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md) — how the first start builds projects from session history and how the GUI orders them.
- [Workspace registration deletion decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md) — why removing a project never deletes its folder or sessions.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
