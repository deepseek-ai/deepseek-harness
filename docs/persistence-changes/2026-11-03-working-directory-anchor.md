---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-working-directory-anchor

English | [中文](2026-11-03-working-directory-anchor.zh.md)

## Summary

Adds an optional anchor to working-directory/change so one change can register the entered checkout as a workspace anchor of the Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-working-directory-anchor
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: "2026-09-13-working-directory"
    after: "376ab95962d99133db02add3a1dda91a257affb2c2e71e64da139b679d82cb88"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events without anchor fold as before: the current-directory projection ignores the property, and the new workspaceRoot projection reads an absent anchor as a move of the current directory with no new anchor, so a stored log keeps its original project as the only anchor. Older readers keep the event type and its cwd; they ignore the optional property and never derived a workspace root, so nothing they interpret changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/working-directory: 37 tests passed, including replay of logs with and without anchor and the user-context text both produce.

<a id="dev-note"></a>
## Dev Note

None.
