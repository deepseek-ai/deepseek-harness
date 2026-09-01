---
description: "SQLite storage backend for hosts and maintainers choosing, configuring, or debugging document-per-row KV storage in one database file."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-sqlite

English | [中文](README.zh.md)

## Summary

`dsh-storage-sqlite` is a storage backend that hosts every routed unit in one SQLite database file, storing each record as one JSON document per row, registered as backend `sqlite`. A single record update touches exactly one row, which is what makes this the right medium for high-frequency, point-sized writes. Choose it when a domain's data changes often or the deployment prefers one queryable database; choose the JSON backend when the data should be readable as plain files. The backend is host-side only: it contributes no prompt, tool, or schema, so the model and the agent loop never see it.

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

Choose it when writes are frequent and point-sized — each key maps to exactly one row, so updating one record touches one row instead of rewriting a whole file. Choose the JSON backend when humans inspect or edit the stored data as plain files. The synchronous `node:sqlite` driver blocks the JavaScript thread for the duration of each single-statement call, which is fine at domain-data scale but worth accounting for at high write rates.

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

Missing directories and database files are created owner-only (`0o700`/`0o600`); an existing database keeps its modes. A unit whose stored format version differs from its descriptor rejects `version-mismatch`, and a database stamped with a physical layout version other than the current one rejects outright — no migration, pre-release stance. Failures carry stable `StorageError` codes, and writes are durable once resolved.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The backend is a document-per-row layout over one `node:sqlite` connection, designed so a per-key update is a single prepared statement.

### Design concept

- **Document per row.** Each unit table becomes a physical STRICT table `u_<unit>_<table> (key TEXT PRIMARY KEY, value TEXT)` whose `value` column holds the record's JSON text; the global singleton lives in a shared `unit_globals` table. One key update touches exactly one row — the reason to route a high-churn domain here.
- **Single-statement atomicity.** Every write primitive is one prepared statement, so SQLite's per-statement atomicity satisfies the KV contract without explicit transactions; write ordering stays the caller's responsibility (the domain layer's write chain).
- **Names validated before DDL.** Unit and table names must match `UNIT_NAME_RE` before they reach DDL, so no external input is ever interpolated into SQL identifiers.
- **Versions fail loud.** The physical layout version lives in `PRAGMA user_version` (fresh databases stamp it last); unit format versions live in the `units` table. Any other stamped value rejects — no migrations.

### Open sequence

Opening the database creates the parent as `0o700`, exclusively creates a missing file as `0o600`, applies `PRAGMA foreign_keys = ON` and the journal mode, checks `user_version`, creates the `units` and `unit_globals` metadata tables, and stamps fresh databases last so a failure leaves the medium unstamped.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: backend registration, `path`/`journalMode` config, unit table |
| [`src/schema.ts`](src/schema.ts) | Open sequence, physical layout version, metadata tables, record table naming |
| [`src/unit.ts`](src/unit.ts) | One opened unit: prepared statements, JSON value parse, close |
| — | No runtime invariant companion is published; schema-version and unit-version consistency are open-time checks that reject before a unit exists, and durability needs the backend round-trip tests in the shared KV conformance suite; this package exposes no continuously observable in-process relation. |

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

- **Synchronous driver blocks the event loop** — each write is a synchronous `DatabaseSync` call; the block lasts a single statement, which is acceptable at domain-data scale.
- **No busy-wait or retry policy** — a competing connection holding a write lock rejects the operation immediately instead of waiting; the domain layer's write chain serializes writes within one process, and cross-process coordination is out of scope.
- **Only the current physical layout version opens** — any other stamped `user_version` is rejected rather than migrated (pre-release stance).
- **Open sequence duplicated with the query provider** — `openDatabase` and `session-query-sqlite` both enforce SQLite file ownership, but each package owns a distinct application identity and schema; no shared medium helper couples them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
