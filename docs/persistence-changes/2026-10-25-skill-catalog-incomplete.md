---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-skill-catalog-incomplete

English | [中文](2026-10-25-skill-catalog-incomplete.zh.md)

## Summary

Adds optional incomplete: true metadata to skill-catalog message sources when discovery returns only the currently readable skills.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-skill-catalog-incomplete
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "9e8043098fb89db6d7c92a92c70146c5c8d24fa88f733c687fa29e5e7a58ab30"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "95acdbd066cf445d37092e5fdfe2e8717ef6ca1aed50f70e2e6037a6989a1f2f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "eaa9125aec0fb28478096c46e73e21bf512ab0d84d826bfb41e7308707734cb5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "39adb7fce8475af6402acd925ea79697b3341c22422ac32833d71217d84e987f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing catalogs omit the flag and remain complete. New readers compare both entries and completeness. Older readers accept the unchanged source discriminator and entry fields, preserve the already-rendered discovery warning in message content, and ignore the optional flag. No event discriminator, required field, or Session format version changes.

<a id="verification"></a>
## Verification

Focused skill-filesystem and tool-skill tests: 71 passed with 100% coverage for both changed source files. Keyless headless skill-root-isolation and skill-load snapshots: 2 passed; the isolation fixture logs the partial catalog and loads a readable skill despite a failing root.

<a id="dev-note"></a>
## Dev Note

None.
