---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-working-directory-workspace

English | [中文](2026-11-11-working-directory-workspace.zh.md)

## Summary

Adds an optional workspace marker to working-directory/change: a marked change moves the Session's workspace root together with its directory.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-working-directory-workspace
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: "2026-09-13-working-directory"
    after: "d9faba79a3513ba57fb26dde8fe980b2adfe01bb6be5bab05c3d64f5017c356a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events without the marker fold as before: the current-directory projection ignores the property, and the new workspaceRoot projection leaves the root at the original project for them, the directory a stored Session already used as its root. The service sets the marker on every change it records from this version on. Older readers keep the event type and its cwd; they ignore the optional property and never derived a workspace root, so nothing they interpret changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/working-directory/tests: 33 tests passed, including replay of logs with and without the marker and a Host move onto a directory that a change without the marker recorded.

<a id="dev-note"></a>
## Dev Note

None.
