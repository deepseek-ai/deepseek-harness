---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-21-system-section-admissions

English | [中文](2026-10-21-system-section-admissions.zh.md)

## Summary

System messages attribute canonical text and optional notices to source IDs. Active records carry order and contentIndex, including empty text; retirement records omit both. After compaction, the next model attempt clears later system messages and resets the initial system message through ordinary single-node replacements.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-system-section-admissions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "2719cd69e8ef5794adcb6ff3df522c33eff0b2677a122a0568d207a8e0147498"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "ce9404e050df94628d8c18d9dbae6e26503a072a7a3ddcff0a43e87f0ec8b6f4"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "1127571148780ee147ee31292fb43e0637b8e035e88f8759036458dfaae06545"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "ed3b0ee800e0ef9ab6ddd10cb18ac8ea2e866f624e599a5201ff7ddc74780c5d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "8fc8f70451996be0a0d33a548f23562ccb258fd7fed18c8e51b380e8d6777950"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing unattributed messages remain readable. Section metadata preserves model-visible text for readers that do not interpret attribution. Deferred rebuilding uses existing system/message events inside an open step and existing single-node replacement operations. No additional event, message projection, or relationship-validation exception is required; the released V4 reader accepts the writes. Session format version remains V4. The system admission projection state version advances to recover pending compaction and the current head from the log. Retirement removes the named source without reading order; older retirement records containing order remain readable.

<a id="verification"></a>
## Verification

[Canonical-envelope tests](../../packages/core/session/tests/canonical-envelopes.spec.ts) cover source metadata validation. [JSONL admission tests](../../packages/session/session-persistence-jsonl/tests/system-rebuild-admission.spec.ts) verify plain and compressed native read/write, released V4 relationship checks, interrupted cleanup prefixes, and rejection of system replacements outside an open step. These focused suites pass locally.

<a id="dev-note"></a>
## Dev Note

None.
