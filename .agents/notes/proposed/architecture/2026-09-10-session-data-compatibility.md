# Agent Note: Session historical data compatibility

Status: proposed

English | [中文](2026-09-10-session-data-compatibility.zh.md)

## Problem

Users care whether old conversations still open after an upgrade, not about internal class names. The abstraction refactor must not incidentally change disk bytes or require manual session moves. The current `0.1.5-rc.1` checkout writes Session format V3 and includes the released-format migration chain through V3.

## Proposal

### Start with 0.1.5-rc.1 / V3

V3 is the current durable Session format, not a projection-cache version. `SESSION_FORMAT_VERSION` is the writer authority; the format catalog owns the released v0→v1→v2→v3 path, including the dedicated V2-to-V3 stage and its delivery guards. Native V3 validation and incoming historical migration remain separate responsibilities.

Do not overwrite old generations or auto-downgrade. Migration writes a new current generation and retains old committed generations for inspection and recovery. A current runtime can open released older formats through the catalog; an older runtime is not promised to read V3.

### Effect on ordinary users

Stages 1–3 only rearrange code ownership. They do not change V3 Session JSONL bytes, `SESSION_FORMAT_VERSION`, or the user startup flow. Ordinary users need no extra manual migration or configuration change for this refactor. On first open of a supported old format, the existing migration pipeline prepares and publishes a current V3 generation. Large logs use streaming stages to avoid whole-artifact memory peaks.

Users should still keep normal backups of `DSH_HOME` before upgrades. If open fails, preserve the full session generation and error text instead of deleting old files. Future providers must distinguish unsupported future versions, corruption, ownership conflicts, and migration failures. The system rebuilds query indexes and other derived data; users do not migrate them manually.

### Invariants after provider replacement

Replacing the in-memory implementation, JSONL provider, or search index does not change logical SessionId, header, event order, fork lineage, or surface. A storage provider reads released formats. Search/statistics caches are derived data that can rebuild from canonical Session content and cannot become recovery authority.

## Alternatives considered

**Re-specify V3 inside the refactor.** Rejected because released-data compatibility is independent of the abstraction stack. This work must preserve the existing format authority and migration evidence, not create a parallel definition.

**Treat every component version named V3 as Session V3.** Rejected because Session logs and derived formats such as projection caches have different durability and recovery rules.

## Acceptance criteria

- The existing V3 catalog, V2-to-V3 stage, native validation, and released-format fixtures remain green.
- Stages 1–5 and provider extraction do not change V3 disk format. A future format change has a separate version, migration, restart, and rollback evidence.
- Users do not edit logs manually. Failures preserve recoverable data and report a precise category.

## Risks

The main risk is accidentally coupling the new abstraction to V3's current JSONL provider, or treating a rebuildable projection cache as canonical Session data. Provider replacement must preserve the released-format contract while keeping physical layout outside ordinary feature code.
