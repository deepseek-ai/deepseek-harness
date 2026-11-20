---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-cua-activity-context

English | [中文](2026-11-18-cua-activity-context.zh.md)

## Summary

Records a macOS window activity notice in the next model request.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-cua-activity-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-21-system-section-admissions"
    after: "41586248fbed6edc749e789f57533377519bb1f5941f8a53149a31e4a3a984d7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-21-system-section-admissions"
    after: "54588f397f0f084fbde634df6be453defaf348a21fdbec869031951f2d9974d8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-21-system-section-admissions"
    after: "9a8fdf1cc2efb1e06832a5191db0636146cd6f073cc4acc61d6ff8fa813def9f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-21-system-section-admissions"
    after: "94e41fc6c2fc24fb9dd979f52c2842d385a89ea92ad9ae52315b6420f523f00d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The cua-activity source adds a discriminator variant without changing existing message payloads. Released V4 readers preserve unknown producer source metadata and message content; current readers continue to accept existing sources. Activity notices are advisory user-role context, not new control events, so the Session format version remains unchanged.

<a id="verification"></a>
## Verification

Released V4 attribution tests cover user and developer messages. The cua-native and cua-ptc replays cover window activity notices recorded before model requests.

<a id="dev-note"></a>
## Dev Note

None.
