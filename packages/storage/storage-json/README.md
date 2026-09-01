---
description: "JSON storage backend for hosts and maintainers choosing, configuring, or debugging whole-unit and per-record files under a configured root."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

## Summary

`dsh-storage-json` stores domain data as readable JSON under a configured root and registers as backend `json`. Its default `single` layout keeps one complete `<unit>.json` file per unit; its `per-record` layout keeps one version-stamped document per record. Both layouts publish each changed file atomically, while the domain layer orders calls. Choose it when operators need inspectable files and the selected layout fits the write volume; choose SQLite for larger or highly concurrent data. The backend is host-side only and contributes no prompt, tool, or schema.

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

Use this package when a composition needs readable, editable JSON storage. Route the relevant domains to backend `json`; each domain specification selects the `single` or `per-record` layout.

### When to choose it

Choose the default `single` layout for small units that benefit from one complete, pretty-printed file. Choose `per-record` when point writes should replace only one record document. Choose the SQLite backend when data is large, writes are frequent, or multiple records need transactional updates.

### Configuration

The only plugin field is `root`, which holds the unit files and directories. It is required because the backend does not fall back to `process.cwd()`. The backend creates the root with mode `0o700` on demand. A domain specification selects its layout; this plugin has no layout override.

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Directory holding `<unit>.json` files and `<unit>/` trees; created `0o700` on demand |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-storage-json) is the exhaustive source for every accepted field and its JSDoc.

### Observable behavior

A missing `single` file or `per-record` directory opens as an empty unit and materializes on the first write. In `single`, malformed content rejects with `malformed-medium`, and a different stored version rejects with `version-mismatch`. In `per-record`, each malformed, unreadable, or differently versioned document reads as an absent record, so one bad document does not reject the unit. Record keys must match `[a-zA-Z0-9_-]+`; an unsafe key rejects before any file operation. Every resolved write is durable, and operations after close reject with `closed`.

An empty `per-record` tree can initialize its declared tables from a valid `<root>/<unit>.json` whole-unit document. The backend leaves that source file unchanged. Any document path in a declared table, or a declared `global.json`, suppresses this initialization for the complete unit, even if that document is unreadable or stale.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two layouts share atomic publication but assign state ownership differently. `single` owns an in-memory unit projection; `per-record` treats its directory tree as authoritative.

### Design concept

- **`single` keeps memory authoritative.** Each write changes the in-memory unit, serializes its complete state, and atomically replaces `<unit>.json`. A failed publish restores the prior in-memory value.
- **`per-record` keeps the directory authoritative.** Each put or delete changes one `<unit>/<table>/<key>.json` document, and `loadAll()` rereads the tree. Each document stamps the unit version and carries one record value.
- **Publication is durable per call.** A write uses a temporary file, fsync, atomic `rename()` replacement, and a parent-directory fsync on POSIX. The domain layer's write chain supplies ordering across calls.

### File formats

A `single` document carries the unit identity, global singleton, and all tables:

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } }
}
```

A `per-record` table document at `<root>/<unit>/<table>/<key>.json` has the form `{ "version": 1, "record": <value> }`; the optional global value uses `<root>/<unit>/global.json`. The format version comes from the domain specification.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: backend registration, `root` config, unit open/close table |
| [`src/single-unit.ts`](src/single-unit.ts) | One `single` unit: authoritative memory, write primitives, publish rollback |
| [`src/per-record-unit.ts`](src/per-record-unit.ts) | One `per-record` unit: tree reads, path-safe records, and one-document writes |
| [`src/format.ts`](src/format.ts) | Whole-unit and record serialization with version validation |
| [`src/atomic.ts`](src/atomic.ts) | Atomic file replacement: temp write, fsync, rename, directory fsync |
| — | No runtime invariant companion is published; correctness here is write-durability and publish-then-reparse equivalence, which require medium round-trip tests (the shared backend conformance suite); the backend exposes no continuously observable in-process relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when this backend's view is not enough: the subsystem reference is the authoritative contract, and the sibling backend shows the alternative medium.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the backend contract, domain semantics, and generated API.
- [Storage package map](../README.md) — the family's packages and their repository position.
- [SQLite storage backend](../storage-sqlite/README.md) — the point-update medium for high-frequency data.
- [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the design behind the backend family and its deferred work.

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

- **`single` rewrites the whole unit** — each write republishes the complete unit file; use `per-record` or route the domain to SQLite when this cost is too high.
- **No cross-process write locking** — two processes writing the same unit can interleave replacements; writes to the same file use last-completion wins.
- **Windows rename without explicit write-through** — durability relies on libuv's `rename()` (`MoveFileExW` with replacement); the stricter Win32 write-through publish helper from the session-log backend is planned to move down here when the `log` facet lands.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Agent Note flags the whole-unit rewrite scale premise as a risk: if a second consumer lands on this backend at thousand-record scale before being routed to SQLite, rewrite cost surfaces earlier than expected. The mitigation is configuration — point `routes` at the SQLite backend — not a change to this package.

</details>
