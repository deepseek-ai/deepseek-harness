---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-team-task-owner-names

English | [中文](2026-11-02-team-task-owner-names.zh.md)

## Summary

Adds optional ownerName to durable Team task snapshots, captured with ownerId during claim or reassignment and cleared with it when ownership ends.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-team-task-owner-names
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "bca0f9cb63d8620b6954bb045b07bb07cb557513a7f0e2e177f5e87f704e7ba7"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Current readers accept existing task payloads without ownerName and display ownerId without rewriting or backfilling historical logs. New task records retain the same ownerId authorization and version 2 task semantics. Earlier Team projections use a strict task schema and reject records containing ownerName, retaining their last valid tasks and reporting a projection failure rather than silently misinterpreting ownership. Session format version remains unchanged. The agentTeam projection state version remains 7: version-7 checkpoints without ownerName remain usable, and suffix replay preserves names from later task events. Version-6 checkpoints still rebuild from events.

<a id="verification"></a>
## Verification

Focused Agent Teams projection, task-board, tool, and JSONL/SQLite recovery tests pass. They cover saved root and nested owner names, clearing ownership, historical ID fallback, rejection of ownerName without ownerId, checkpoint rebuilds, and task reads and edits without descendant catalog queries.

<a id="dev-note"></a>
## Dev Note

None.
