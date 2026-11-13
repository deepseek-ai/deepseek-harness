---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-workspace-root-change

English | [中文](2026-11-13-workspace-root-change.zh.md)

## Summary

Adds the workspace-root/change event, which moves a Session's current directory and its workspace root together. working-directory/change keeps its payload and has no writer.

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

New readers fold both events: workspace-root/change sets the current directory and the workspace root, and working-directory/change sets only the current directory, so a stored Session keeps its original project as its root. A Session that never moves its workspace holds neither event and older readers read it as before. Older readers do not know workspace-root/change, which carries no ignorable marker, so they refuse a log that holds it when they decode the row; they never reconstruct a directory that misses the move.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/working-directory/tests: 33 tests passed, including replay of a log holding workspace-root/change, a stored working-directory/change that leaves the root at the original project, and a Host move onto a directory that a working-directory/change recorded. pnpm exec vitest run packages/session/session-format-catalog/tests/catalog.spec.ts: 23 tests passed, including refusal of a required event type outside the reader's vocabulary.

<a id="dev-note"></a>
## Dev Note

None.
