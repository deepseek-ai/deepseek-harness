# Agent Note: JSONL-only first-party Session persistence

Status: implemented

English | [中文](2026-08-30-jsonl-only-session-persistence.zh.md)

## Problem

The product ships and exercises JSONL as its authoritative Session store, while the optional SQLite Session-persistence provider duplicates the same logical service over a second physical format. Every Session contract, event-envelope change, recovery rule, package graph, platform lane, and format transition therefore carries a second implementation and test matrix even though shipped profiles do not select it. Released Session-format migration also needs an exact per-Session source artifact that can be archived before replacement; the single-database provider would require a separate publication design without serving a current deployment.

The SQLite full-text Session-query provider is not an alternative authoritative store. It observes persistence through `ctx.sessionPersistence` and maintains a separate disposable derived index. The generic SQLite domain-KV provider is also independent of Session logs.

## Decision

`@deepseek-ai/dsh-session-persistence-jsonl` is the sole first-party implementation of `ctx.sessionPersistence`. The abstract Service Definition remains backend-neutral so an out-of-tree provider can implement the same service, but the repository owns and tests one authoritative physical Session format.

The `@deepseek-ai/dsh-session-persistence-sqlite` package, its schema resources, backend-specific tests, configuration surface, and Windows differential lane are absent. Cross-package persistence tests use the real JSONL provider or an owner-local fake. `@deepseek-ai/dsh-session-query-sqlite` remains the optional FTS5 query provider over a separate rebuildable database, and `@deepseek-ai/dsh-storage-sqlite` remains the generic domain-KV provider.

Existing databases written by the removed provider are not opened or migrated by the current build. An operator who needs their contents must use a build that still contains that provider and export the logical Session before upgrading.

## Alternatives considered

- **Keep SQLite as an opt-in differential backend.** Rejected because an unselected production provider still multiplies every durable-format, lifecycle, platform, and migration obligation; contract fakes and the JSONL provider cover the shared service without retaining a second authoritative format.
- **Keep a read-only SQLite import package.** Rejected because it would preserve the package graph and schema maintenance without a demonstrated deployment need. A recovery tool can be designed later if real retained databases require one.
- **Use the Session-query SQLite database as persistence.** Rejected because that database is a disposable projection with independent ownership, schema, and rebuild semantics; treating it as authority would merge two unrelated storage roles.

## Consequences

Session persistence has one first-party physical format and one first-party durability path. The migration stack can archive and atomically replace one per-Session JSONL artifact without implementing a parallel database transaction protocol. SQLite search remains available and its integration tests now prove that it observes JSONL rather than sharing an authoritative database.

Removing the provider is a deliberate compatibility cut for its opt-in database files. The change reduces implementation and CI surface but also removes the stronger database/WAL storage option; a future provider needs a current owner, deployment need, complete shared-contract evidence, and its own format-transition policy.
