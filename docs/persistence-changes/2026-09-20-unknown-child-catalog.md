---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-20-unknown-child-catalog

English | [中文](2026-09-20-unknown-child-catalog.zh.md)

## Summary

Retain unreadable historical children in subagent/catalog with unknown mode.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-20-unknown-child-catalog
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-11-initial"
    after: "3abae7324356f155cb42450c00b806d134ec93bd6439d2063b8d724162d58604"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Catalog payload v0 remains unchanged. Payload v1 adds unknown mode, and current readers accept v0 and v1. Complete facts still use v0; migration emits v1 for unknown children. Existing logs need no rewrite, and the Session header remains V4. Older readers reject v1. The classifier allows higher event payload versions only when all old payload alternatives remain unchanged; same-version widening and removal of old readers stay breaking.

<a id="verification"></a>
## Verification

Migration, restoration, projection, and Web regressions retain unknown membership and child-local errors. Classifier tests accept higher payload versions with preserved predecessors and reject same-version additions, invalid versions, changed or removed old alternatives, and header/surface changes.

<a id="dev-note"></a>
## Dev Note

None.
