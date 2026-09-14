---
description: "The storage group map: durable non-session data through named backends and the typed domain data form, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/storage

English | [中文](README.zh.md)

## Summary

The storage group keeps non-session application data across restarts, including workspace records and session sidecars. Choose `storage-json` for human-readable files or `storage-sqlite` for point updates in one database; `storage-domain` adds schema-validated typed records and change notifications, while `storage` selects the configured backend. These packages are optional and host-side: they do not expose tools, prompt content, or session events to the model. Use the group when application state must outlive a process, and omit it when the composition has no such data.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`storage`](storage/README.md) | Connects registered backends with mounted data-form facilities | `ctx.storage` |
| [`storage-json`](storage-json/README.md) | Stores each unit as one human-readable JSON file | registers backend `json` |
| [`storage-sqlite`](storage-sqlite/README.md) | Stores units as JSON documents in one SQLite database | registers backend `sqlite` |
| [`storage-domain`](storage-domain/README.md) | Provides schema-validated, change-emitting KV domains over routed backends | `ctx.storageDomain` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Storage subsystem](../../docs/subsystems/storage.md) — the authoritative contract: the backend contract, domain declaration, change events, and generated API.
- [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the design behind the family, the workspace consumer, and the deferred session-backend migration.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the first consumer of the domain data form.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The design Agent Note is still marked proposed while the family ships; its out-of-scope table is the deferred-work list for the migration phase (the `log` facet, session-backend reuse, cross-process change push). Promote decisions into implemented notes as they land.

</details>
