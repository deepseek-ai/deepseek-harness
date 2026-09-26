# Agent Note: Complete parent catalogs without migrating child catalogs

Status: implemented

English | [中文](2026-09-19-session-local-subagent-migration.zh.md)

## Problem

Opening a historical parent requires discovery facts from its direct children. A child's corrupt body or invalid descriptor, or an unreadable header elsewhere in the root, could reject the parent's V4 preparation and hide otherwise readable history.

## Decision

Opening A discovers candidate B Sessions through headers, reads their own descriptors, and completes A's catalog. Historical child reads use the V0–V3 catalog; current child reads use native validation. These reads neither prepare B's own catalog nor publish B's successor. Opening B separately performs B's migration and catalog preparation. Frontend discovery retains its parent-catalog source. Unknown-mode rows remain browsable; `list_agents` continues to select only known continuable children.

JSONL omits unreadable or unsupported headers from discovery. A child-body or descriptor-field failure produces a warning with the child path and retains the child's header identity. If the parent lacks a complete entry, migration appends `subagent/catalog`, projected as `mode: 'unknown'` alongside healthy siblings. Existing complete entries remain authoritative. Cancellation and source-consistency failures still stop the operation. Inspected child revisions, including failed decodes, are rechecked before reuse and publication so repairs cannot silently reuse stale evidence. Released predecessors remain byte-identical.

This partially supersedes child-failure propagation in [released migrations](../architecture/2026-08-31-released-session-format-migrations.md) and [incomplete child evidence](2026-09-19-v3-incomplete-child-catalog-evidence.md). Their format conversion, descriptor cardinality, conflict validation, and immutable publication rules remain active.

## Alternatives considered

**Skip catalog completion and discover children in each consumer.** This introduces incomplete tool results and additional UI states despite the parent's readable child descriptors. The parent catalog already serves these consumers.

**Drop unreadable children from the catalog.** Published parents would lose their navigation entries. Header identity is sufficient to retain membership without inventing a mode or label.

**Recursively prepare child catalogs.** A only needs B's own descriptor. Preparing B's descendants adds unrelated work and failure dependencies.

**Refuse A when one child cannot be read.** The child's discovery metadata does not justify withholding the parent's healthy history. Warnings retain the child location without inventing mode or label fields.

## Consequences

Initial parent preparation still scans headers and reads direct-child bodies one at a time. It does not claim to eliminate this I/O. Published V4 parents use their catalog without rescanning children. Unknown entries are not automatically rewritten after publication. Opening a child retries its log and determines browsing capabilities from its actual descriptor, or reports the child-local error. Catalog payload v0 retains its two known modes; v1 also supports `unknown`. Readers support both versions; healthy creation and complete historical facts retain v0, while unknown migration facts use v1. The V4 Session header is unchanged, and older readers reject the new payload version.

Raw and compressed tests cover catalog completion, child-local errors, source changes and repairs, unchanged child generations, and deferred child-catalog preparation. The shipped Web migration snapshot checks the parent catalog with a corrupt sibling, then opens the child independently. Its additional historical child raises the corpus budget from ten to eleven roles; the guard rejects a twelfth role.
