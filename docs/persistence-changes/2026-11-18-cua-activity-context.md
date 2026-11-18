---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-cua-activity-context

English | [中文](2026-11-18-cua-activity-context.zh.md)

## Summary

Records macOS computer-use activity as producer-owned tool context.

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
    previous: "2026-11-05-timeline-priority-notice"
    after: "80d7a49ed6017af1a023488430fc8e9b7679f7af50c8b5ad6c843ae3a90719af"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "cb5e0389ac2f78305e882f895e4e55d31f44e48c28292ed44adff6193354fc67"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "696c7e4bb21e7754a5546078c1b45a82c4a7f0fbeab860bacf89070266d6a16c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8bac8ab331c25847ac29a4852578098b8684e44c6bcdfecb8f507db3cfed7402"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The cua-activity source adds a discriminator variant without changing existing message payloads. Released V4 readers preserve unknown producer source metadata and message content; current readers continue to accept existing sources. Activity notices are advisory user-role context, not new control events, so the Session format version remains unchanged.

<a id="verification"></a>
## Verification

The recent-activity tool-pipeline tests pass. The released V4 attribution tests pass for user and developer messages; cua-native and cua-ptc snapshot refreshes pass, including a program that never calls inspect.

<a id="dev-note"></a>
## Dev Note

None.
