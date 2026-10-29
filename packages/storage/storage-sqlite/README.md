---
description: "SQLite storage backend for hosts and maintainers choosing, configuring, or debugging document-per-row KV storage in one database file."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-sqlite

English | [中文](README.zh.md)

## Summary

`dsh-storage-sqlite` is a storage backend that hosts every routed unit in one SQLite database file, storing each record as one JSON document per row, registered as backend `sqlite`. A single record update replaces one data row, which is what makes this the right medium for high-frequency, point-sized writes. Choose it when a domain's data changes often or the deployment prefers one queryable database; choose the JSON backend when the data should be readable as plain files. The backend is host-side only: it contributes no prompt, tool, or schema, so the model and the agent loop never see it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when a composition keeps frequently updated domain data in one database: route the relevant domains to this backend and each unit materializes as tables in the configured database file.

### When to choose it

Choose it when writes are frequent and point-sized — each key maps to one data row, so updating a record avoids rewriting the whole unit. The first mutation of an accepted older unit also updates its version metadata in the same transaction. Choose JSON when humans inspect or edit stored data as plain files. The synchronous `node:sqlite` driver blocks the JavaScript thread for each write call, including that initial transaction; account for this at high write rates.

### Configuration

Two fields: the database path and the journal mode. `:memory:` opens an in-process database whose contents disappear with the process.

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-sqlite'
  config:
    path: /var/lib/dsh/data.db
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: sqlite
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | SQLite database file path, or `:memory:` |
| `journalMode` | `wal` | Journal mode: `wal`, `delete`, `truncate`, or `persist` |

`wal` suits local disks; a rollback-journal mode (`delete`/`truncate`/`persist`) fits filesystems where WAL's shared-memory files do not work, such as network mounts. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-storage-sqlite) is the exhaustive source for every accepted field and its JSDoc.

### Observable behavior

Missing directories and database files are created owner-only (`0o700`/`0o600`); an existing database keeps its modes. A unit accepts its descriptor's current version or `compatibleVersions`, otherwise rejects `version-mismatch`. Accepted older units retain their stamp on read; the first mutation commits data and the current stamp in one transaction. Deleting missing keys or an empty batch leaves the stamp unchanged. Untouched record values and other units remain unchanged; the backend does not convert application values. A database stamped with a physical layout version other than the current one rejects outright; domain compatibility does not migrate the database layout. Storage checks use `StorageError` codes; underlying SQLite failures propagate, and writes are durable once resolved.

Every nonempty batch delete uses one transaction, including its version update when needed. A failed transaction preserves data and stamp when SQLite rolls back successfully, including an automatic rollback. A failed `BEGIN` leaves the batch unapplied and permits retry on the same handle. If rollback itself fails, the backend retains a `StorageError` with code `unknown-state` whose cause is an `AggregateError` containing both failures, and rejects further unit reads, writes, and pending or new opens. The transaction outcome is unknown. Close the backend and its domains, then create a new backend to inspect saved state before deciding whether to retry. See [domain versioning](../../../docs/subsystems/storage.md#domain-versioning) for mixed records and downgrade behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The backend is a document-per-row layout over one `node:sqlite` connection. Per-key writes reuse prepared statements; a version upgrade adds the metadata update and transaction.

### Design concept

- **Document per row.** Each unit table becomes a physical STRICT table `u_<unit>_<table> (key TEXT PRIMARY KEY, value TEXT)` whose `value` column holds the record's JSON text; the global singleton lives in a shared `unit_globals` table. A key update replaces one data row; advancing the unit stamp also updates its metadata.
- **Atomic writes.** Current-version single-record writes use one prepared statement. Batch deletes and the first mutation of an accepted older unit share one transaction helper; the first mutation includes its current version stamp. Successful rollback preserves both data and stamp. Write ordering stays the caller's responsibility (the domain layer's write chain).
- **Names validated before DDL.** Unit and table names must match `UNIT_NAME_RE` before they reach DDL, so no external input is ever interpolated into SQL identifiers.
- **Separate version checks.** The physical layout version lives in `PRAGMA user_version` (fresh databases stamp it last) and must match exactly. Unit versions live in `units` and also accept the owner's declared `compatibleVersions`; record conversion belongs to the owner.

### Open sequence

Opening the database creates the parent as `0o700`, exclusively creates a missing file as `0o600`, applies `PRAGMA foreign_keys = ON` and the journal mode, checks `user_version`, creates the `units` and `unit_globals` metadata tables, and stamps fresh databases last so a failure leaves the medium unstamped.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: backend registration, `path`/`journalMode` config, unit table |
| [`src/schema.ts`](src/schema.ts) | Open sequence, physical layout version, metadata tables, record table naming |
| [`src/unit.ts`](src/unit.ts) | One opened unit: prepared statements, JSON value parse, close |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when this backend's view is not enough: the subsystem reference is the authoritative contract, and the sibling backend shows the alternative medium.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the backend contract, domain semantics, and generated API.
- [Storage package map](../README.md) — the family's packages and their repository position.
- [JSON storage backend](../storage-json/README.md) — the human-readable medium for small, inspectable data.
- [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the design behind the backend family and the deferred session-backend migration.

-----

<a id="model-experience"></a>
## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Synchronous driver blocks the event loop** — writes use synchronous `DatabaseSync` calls; batch deletes and an accepted older unit's first mutation hold their transaction on the JavaScript thread.
- **No busy-wait or retry policy** — a competing connection holding a write lock rejects the operation immediately instead of waiting; the domain layer's write chain serializes writes within one process, and cross-process coordination is out of scope.
- **Only the current physical layout version opens** — any other stamped `user_version` is rejected rather than migrated (pre-release stance).
- **Version checks remain unit-wide** — a `per-record` layout request does not add per-record stamps or JSON's absent-document recovery policy to this backend.
- **Open sequence duplicated with the query provider** — `openDatabase` and `session-query-sqlite` both enforce SQLite file ownership, but each package owns a distinct application identity and schema; no shared medium helper couples them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
