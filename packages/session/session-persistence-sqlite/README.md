---
description: "Save and reopen Session histories in SQLite, import existing JSONL histories, and coordinate concurrent readers and writers."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

Save Session histories in SQLite and reopen them through the existing persistence API. Existing JSONL histories import on first open while their source files remain intact. Readers can share a database with an active writer; each Session permits one writer. Choose this provider explicitly: shipped profiles continue to use JSONL.

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

Mount this provider for the storage root whose Sessions should use SQLite.

### Minimal configuration

Replace the JSONL provider's package name in your composition, preserving its root and legacy encoding settings:

```yaml
- name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    root: './.sessions'
```

The database lives at `<root>/.segments/sessions.sqlite`. Application callers continue to use `ctx.sessionPersistence` and its Session handles.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Storage root containing the database and any existing JSONL histories. |
| `compression` | `zstd` | Existing JSONL encoding; SQLite events use ordinary JSON. |
| `listConcurrency` | `3` | Concurrent filesystem reads for legacy metadata and routing records. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-sqlite) documents all accepted fields.

### Opening existing history

A first read or write open decodes the selected JSONL generation through its version migration chain, then imports the current logical history into SQLite. Import preserves metadata, event order, source coordinates and the inheritance marker. It creates an independent root Segment and retains the JSONL source bytes. The imported Session and its later events reopen through SQLite.

An active JSONL writer retains ownership until it closes. A SQLite read open waits for that ownership; a competing write open rejects. Cancellation or provider disposal stops the wait. After import, readers can open while the SQLite writer remains active. `stat()` and `list()` observe metadata without importing history.

### Durability and shutdown

Direct append, live Session events and durability checkpoints use the same handle. `flush()` drains pending events; writer close and provider disposal finish admitted writes before releasing ownership. An automatic write failure retains its pending batch and pauses automatic writes; the next explicit checkpoint retries and reports any remaining failure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin supplies the existing persistence service and uses a JSONL provider in an isolated service context to read legacy histories. Import acquires the Session's artifact lease, commits its metadata and events in a database transaction, then records SQLite routing. A write open retains the lease through the handoff.

SQLite keeps thread metadata, predecessor-linked Segment metadata and indexed JSON event rows. WAL is enabled before schema publication so a concurrent reader cannot prevent the first mode switch. The backend owns write queues, live-event buffering, transaction completion and handle cleanup; callers do not address Segments.

| Source | Responsibility |
|---|---|
| [persistence.ts](src/persistence.ts) | Service routing and durable JSONL takeover. |
| [migration.ts](src/migration.ts) | Import sequencing, ownership handoff and cancellation. |
| [sqlite.ts](src/sqlite.ts) | Database, Segment access, handles and durability. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence](../session-persistence/README.md) — the shared service and handle semantics.
- [JSONL persistence](../session-persistence-jsonl/README.md) — physical generations and version migration.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — recovery and consumer-facing APIs.

-----

<a id="model-experience"></a>
## Model Experience

### Restored history

#### What the model sees

This provider adds no prompt or tool schema. Restored `user/message` and `assistant/message` events supply the same conversation history; the Session consumer owns interrupted-turn repair.

#### Token effect

Storage adds no tokens. Restored history has its usual conversation cost.

#### KV Cache effect

Storage preserves event order and does not rewrite model request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply when selecting this provider.

- The first legacy read open writes the SQLite database and requires write access to the storage root.
- Retained JSONL files contain the imported prefix and exclude later SQLite events; they cannot restore the latest history on their own.
- All processes writing imported Sessions must use the SQLite provider.
- SQLite accepts the current Session format; a future event-format upgrade needs its own SQLite history migration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
