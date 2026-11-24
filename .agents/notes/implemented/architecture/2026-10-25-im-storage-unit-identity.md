# Agent Note: IM storage unit identity in v4

Status: implemented

English | [中文](2026-10-25-im-storage-unit-identity.zh.md)

## Problem

Booting v4 over an existing home fails before the service starts (`StorageError: unit 'im': stored version 1 != expected 2`) when a v4 message store reuses the v3 `im` unit name at version 2 with a different table layout (`events`/`messages`/`chats` instead of v3's `sessions`/`tasks`/`intake`/`output`). A unit name is its identity on the storage medium and a single-document unit is read at its exact version only, so reusing a v3 unit name with an incompatible layout or record schema fails on every boot over a v3 home.

The storage domain layer has no in-place migration or reset hook: [`DomainSpec`](../../../../packages/storage/storage-domain/src/spec.ts) declares a name, a version, a layout, and record schemas, and [`KvFacet`](../../../../packages/storage/storage/src/backend.ts) provides `open`/`loadAll`/`putRecord`/`deleteRecord`/`setGlobal`/`close` without a transform or destroy primitive ([`packages/storage/storage-domain/README.md`](../../../../packages/storage/storage-domain/README.md)). Moreover, v3 intake receipts and hosted sessions are not reusable by the v4 IM packages, whose admission, session, receipt, and task records have different schemas.

## Decision

Each IM storage domain uses its own v4 unit name, leaving pre-v4 unit names unused:

| Domain | Unit (v4) | Owner |
|---|---|---|
| Message store: events, messages, chats | `im_messages` | `packages/experimental/im/src/state.ts` |
| Hosted sessions and pending deliveries | `im_sessions` | `packages/experimental/im/src/sessions.ts` |
| Publication receipts | `im_receipts` | `packages/experimental/im/src/send.ts` |

Because each v4 domain has a new unit name, each starts at version 1. Existing pre-v4 `im`, `im_conversation`, and `im_dispatch` units remain untouched on the storage medium: nothing in v4 reads, migrates, or deletes them, and the first v4 boot opens empty v4 stores cleanly without manual intervention. A deployment that ran the removed task plugin keeps its `im_tasks` records the same way: no v4 domain opens that unit.

## Alternatives considered

**Declare a v1-to-v2 migration that discards the v3 state.** `DomainSpec` and the storage backend contract have no migration, reset, or destroy hook; adding one would require new storage-layer primitives ([the `recovery: 'reset'` proposal](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.md)), and reaching around the storage backend from the IM package would break backend abstraction.

**Keep the `im` name and bump the version to 2.** A single-document unit is checked for an exact version match, so version 2 over a stored version 1 unit fails with `version-mismatch` on every boot.

**Keep the old unit names and loosen schemas to accept v3 records.** v3 and v4 records represent different data models; accepting v3 records under v4 schemas would misinterpret obsolete routing and intake state instead of starting clean.

**Delete the v3 units at boot.** The storage backend provides no unit-deletion primitive, and deleting user storage files automatically during service startup is outside the IM package's scope.

## Consequences

An upgraded `$DSH_HOME` retains any pre-v4 `im.json`, `im_conversation.json`, and `im_dispatch.json` files unused alongside the v4 unit files. The v4 IM service starts with fresh message, session, and receipt stores.

Any future compatible schema change within one of these three domains increments that unit's version and declares `compatibleVersions` only when existing records remain valid under the new schema.

Verification: `packages/experimental/im/tests/store.spec.ts` boots the message store over a medium seeded with a v3-shaped `im` unit at version 1, verifies that v4 writes land in `im_messages` while the v3 unit stays untouched, and verifies that opening `im` at version 2 rejects with `version-mismatch`.
