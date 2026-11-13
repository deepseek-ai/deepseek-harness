---
description: "Store Session history in SQLite and import retained JSONL logs through the Session persistence plugin."
kind: "package-library"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

Save Session history in SQLite while keeping the existing Session read and write interface. The Session persistence plugin uses this library for new Sessions and imports supported JSONL history on first open. Imported source files remain available for archival purposes. Node hosts use SQLite; browser Workers select the plugin's JSONL backend.

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

Configure storage through the [Session persistence plugin](../session-persistence-jsonl/README.md). This library has no standalone Cordis plugin entry. Its [public exports](src/index.ts) provide the storage implementation to that plugin; application consumers use the [Session persistence service](../session-persistence/README.md).

### Storage and import

The plugin stores the database at `<root>/.segments/sessions.sqlite`. New Sessions commit their metadata and event history to SQLite. A Session without appended events remains unmaterialized until its owner flushes it. SQLite uses WAL mode and FULL synchronous commits; flush joins admitted writes, and failures reject the durability checkpoint.

Opening supported JSONL history acquires the Session's legacy write lease, reads it through the existing format migration chain, and imports metadata and events in one transaction. Original generations remain unchanged. Read opens that encounter another importer wait for its commit and then read SQLite while a writer remains active. Write opens still reject ownership contention. Cancellation or provider disposal stops waiting readers. Listing and stat do not import history.

Once imported, a Session reads from SQLite. Routing records beside the database retain this selection; missing database files with retained routing records cause an error. Retained JSONL files do not include subsequent SQLite events and provide no automatic fallback or downgrade.

### Closing and ownership

Each Session permits one writer. Public handle operations reject after closing begins. Routed live events remain accepted while close drains pending writes; close releases the writer and routing after the drain settles. Storage failures remain visible to the owner. Provider disposal removes listeners and closes remaining handles after dependent consumers unload.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`TracePersistence` combines SQLite history with legacy discovery and import. `SqliteLogs` stores logical event JSON and source event sequence arrays in independent root Segments. Database schema checks and creation share a transaction; the schema version is monotonic. Session leases coordinate writers across processes, and committed routing records select the database for later opens.

| File | Responsibility |
|---|---|
| [persistence.ts](src/persistence.ts) | Session service implementation and durable routing |
| [migration.ts](src/migration.ts) | Legacy import ownership and waiting readers |
| [sqlite.ts](src/sqlite.ts) | Database transactions, reads, live events, and handle closure |
| [lease.ts](src/lease.ts) | Cross-process writer ownership |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) explains shared service semantics.
- [Session format catalog](../session-format-catalog/README.md) defines supported logical history versions.
- [SQLite storage upgrade](../../../docs/upgrade-guide/v0.2.2-rc.2/session-sqlite-storage/guide.md) explains backup and storage selection.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

SQLite storage adds no live prompt or tool schema. The Session loader reconstructs recorded history; interrupted turns record `TOOL_NOT_STARTED` or `TOOL_OUTCOME_UNKNOWN` through the recovery behavior documented by the [Session persistence service](../session-persistence/README.md).

#### Token effect

Zero additional live-request tokens. Resumed requests include retained history and any recovery results supplied by the Session loader.

#### KV Cache effect

SQLite storage does not alter live request prefixes. Cache reuse on resume depends on the reconstructed history and the active model route.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Node runtime required** — the backend uses Node SQLite and platform writer locks; browser Workers use JSONL through the persistence plugin.
- **Imports do not synchronize formats** — retained JSONL generations stop receiving events after import; switching storage cannot recover later SQLite writes from those files.
- **Back up the complete storage root** — routing records and database history belong together; copying only retained JSONL loses later events. Stop writers before copying the root.
- **One live writer per Session** — readers may coexist with that writer, but a competing write open rejects.
- **Session history accumulates** — the persistence service has no deletion API.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
