---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-workspace-root-change

English | [中文](2026-11-13-workspace-root-change.zh.md)

## Summary

Adds the workspace-root/change event, which records a Host move of a Session's directory. working-directory/change keeps its payload and has no writer.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-workspace-root-change
baseline: false
changes:
  - root: "event:workspace-root/change"
    previous: null
    after: "025f11632cd02aaecc23a46c3b5bf43b9009d88293ed9b35ccbc1139d73334dc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers fold both events into one directory. workspace-root/change sets it. A stored working-directory/change sets it only when its directory lies inside the Session's original project, which keeps the directory and the relative paths of a Session that worked in a worktree or a subdirectory of its project. This narrows the meaning of a stored working-directory/change whose directory lies outside the original project: earlier readers kept it as the current directory, and this reader returns the Session to the project, because the model could choose that directory and consumers bound writes by the Session's directory. The next request's context reports the directory to the model. A Session that never moves holds neither event and older readers read it as before. Older readers do not know workspace-root/change, which carries no ignorable marker, so they refuse a log that holds it when they decode the row; they never reconstruct a directory that misses the move.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/working-directory/tests: 30 tests passed, including replay of stored working-directory/change events inside the project, outside it, after a Host move, in a Session without origin metadata, and under a symlinked header. pnpm exec vitest run packages/session/session-format-catalog/tests/catalog.spec.ts: refusal of a required event type outside the reader's vocabulary.

<a id="dev-note"></a>
## Dev Note

None.
