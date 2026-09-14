---
description: "The workspace group map: the persistent workspace entity family, durable directory records, and header-validated session membership, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/workspace

English | [中文](README.zh.md)

## Summary

The workspace family lets a host product keep an ordered list of named projects and group each project's sessions by directory. Users can browse those projects and sessions, hide a session from the grouping without deleting it, and remove a project without deleting its folder or session history. Hidden or removed sessions remain available as ungrouped history. Choose this family for a persistent project surface; it requires session storage and a persistence backend, and it does not expose tools, prompts, or session events to the model.

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
