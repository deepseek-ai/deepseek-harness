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

New readers set a Session's directory from workspace-root/change and ignore working-directory/change. This changes the meaning of a stored working-directory/change: earlier readers moved the current directory to it, and this reader leaves the Session in its original project, or in the directory of its last workspace-root/change. The event recorded both a model's cd and an entered worktree without telling them apart, and consumers bound writes by the Session's directory, so a directory the model chose must not become that boundary. A Session that had entered a worktree resumes in its original project and returns through enter_worktree. The next request's context reports the directory to the model. A Session that never moves holds neither event and older readers read it as before. Older readers do not know workspace-root/change, which carries no ignorable marker, so they refuse a log that holds it when they decode the row and do not rebuild a directory that lacks the move.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/working-directory/tests: 29 tests passed, including replay of stored working-directory/change events inside and outside the project, before and after a Host move, and in a Session without origin metadata, none of which moves the directory. pnpm exec vitest run packages/session/session-format-catalog/tests/catalog.spec.ts: refusal of a required event type outside the reader's vocabulary.

<a id="dev-note"></a>
## Dev Note

None.
