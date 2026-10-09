---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-13-working-directory

English | [中文](2026-09-13-working-directory.zh.md)

## Summary

Adds durable per-Session working-directory changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-13-working-directory
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session headers and events remain valid. The new event is required on read: older builds that do not know working-directory/change refuse logs containing it. The event vocabulary grows without changing the structural Session format.

<a id="verification"></a>
## Verification

Focused working-directory and system-prompt suites pass 113 tests with per-file 100% coverage. Keyless headless replay verifies changes, recovery, user-context notices, and a stable system prompt.

<a id="dev-note"></a>
## Dev Note

None.
