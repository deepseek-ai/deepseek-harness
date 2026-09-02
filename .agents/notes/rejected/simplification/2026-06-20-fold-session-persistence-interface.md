# Agent Note: Fold the persistence interface into dsh-session

Status: rejected — the separate persistence Service Definition package is the intended modular role split for the durable-persistence capability seam. Folding it into `dsh-session` would reduce package count at the cost of a cleaner backend boundary.

English | [中文](2026-06-20-fold-session-persistence-interface.zh.md)

## Problem

`dsh-session-persistence` is a Service Definition package whose main concepts are already owned by `dsh-session`: `SessionHeader`, `SessionEvent`, `SessionId`, `session/event`, and `session/flush`. The package adds the abstract `SessionPersistence` service, the shared write coordinator, and contract helpers. Provider packages depend on it, and `agent-loop` has to optionally find a sibling service for resume.

The capability-seam split made sense when persistence was a new swappable backend design. After the mutable summary was removed, the Service Definition package mostly wraps the session log's own storage concern. Keeping it separate may be more ceremony than clarity.

## Proposal

Move the abstract `SessionPersistence` service, the coordinator, and persistence contract helpers into `dsh-session`. Keep JSONL and SQLite as separate backend packages that register the session-owned service. This preserves backend swappability while deleting one support package and one cross-package boundary.

The implementing PR should update the [capability seams](../../implemented/architecture/2026-06-13-capability-seams.md) guidance with the exception: persistence is not like bash or LLM because its vocabulary and lifecycle events are already the session package's core domain.

## Acceptance criteria

- `@deepseek-ai/dsh-session-persistence` is removed as a package.
- `dsh-session` exports the persistence service type, coordinator, and contract helpers.
- JSONL and SQLite backend packages depend on `dsh-session` directly.
- `agent-loop` resume uses the session-owned service key.
- [Session persistence](../../implemented/architecture/2026-06-14-session-persistence.md), [handle-based session persistence](../../implemented/architecture/2026-08-27-handle-based-session-persistence.md), and [package docs](../../../../packages/session/session-persistence/README.md) explain why backend implementations remain separate.

## What we give up

`dsh-session` becomes heavier: it owns both the in-memory log and the persistence Service Definition. That is the trade. If third-party persistence backends were already a public ecosystem, the separate Service Definition package would be a cleaner SDK boundary; pre-release, the extra package looks like abstraction before there is an external Consumer.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
