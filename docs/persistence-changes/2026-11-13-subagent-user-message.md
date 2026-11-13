---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-subagent-user-message

English | [中文](2026-11-13-subagent-user-message.zh.md)

## Summary

Adds a subagent-owned notice identifying the following browser-authored user message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-subagent-user-message
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "7cd1114a345c75f6d68db07a4961f0f09279266e2645f3d5833bcc7f7bae0cf3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "004e48d8009062e92150686eaf56d0581347dc6642984c62b49148adcfba9127"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "1ef3ab54f9530d6d9fbefc188d06716074948057eb2c7c8a7fd65bc2ae362599"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "60263b853fa333f7f550c2b115192ed07ae1e3e22437d3b638a60b0f726d794b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain readable without changes. The new subagent-user-message source is attribution only: readers preserve its metadata and user-role content without the producer, and existing notice-form presentation handles it. No replay or authority decision depends on this kind. Older readers can derive the already-recorded notice and raw human message; newer readers do not insert notices into old history. The additional source alternative leaves the existing event payloads and Session version unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent/tests: 509 tests passed, including persisted cold Queue/Steer attribution, unchanged root and agent messages, and edited resident input. The authored Web subagent-human-message scenario refreshed successfully through the shipped Web composition.

<a id="dev-note"></a>
## Dev Note

None.
