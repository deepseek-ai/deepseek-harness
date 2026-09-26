---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-schedule-optional-title

English | [中文](2026-09-18-schedule-optional-title.zh.md)

## Summary

Makes the stored title optional on the after, at, and every variants of a persisted schedule/change create record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-schedule-optional-title
baseline: false
changes:
  - root: "event:schedule/change"
    previous: "2026-09-11-initial"
    after: "a0a2e5c42e1c929445ecd1cd70f49be6b66441894ec72c08e8ae332821d4a3cb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A version-1 Session event written before titles existed has no title member, so those logs decode and fold without one instead of being refused. Readers that require a name treat an absent title as an unnamed task. The Host task record still requires the member: the storage decoder rejects a stored task without it, and creation, update, and the schedule tools still require it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/schedule/schedule/tests: 18 files, 789 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
