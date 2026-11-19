---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-19-cua-input-notices

English | [中文](2026-11-19-cua-input-notices.zh.md)

## Summary

Adds cua-held-inputs and cua-inputs-released producer attribution using the existing notice form and text content.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-19-cua-input-notices
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-21-system-section-admissions"
    after: "a11e08189f96d25e03ccd0653567670f61acf64906c1c63c90ee9b893738bab7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-21-system-section-admissions"
    after: "a73ee1696868d73a95bc7b611037794a4e0b5abe2151ddd18164303fe72fb9f4"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-21-system-section-admissions"
    after: "a56439237396867aceecf24eea7328260ea78aa97487dda14cb40db6b0126ec4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-21-system-section-admissions"
    after: "6c2bcfd03238f2325c071320efaf8e78a25d430dfaeeba309d0a362f4e92b3a1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

This remains Session format V4. New readers retain every previous source kind and event field. Released V4 readers accept nonempty unknown producer kinds in user/developer messages, preserve their metadata and text, and already understand notice summaries. The same source objects occur in queued inbox messages and recorded title-request messages. These two kinds describe input state; restoring or deriving a Session does not replay native input or recreate holds. No event discriminator, header, message role or existing source meaning changes.

<a id="verification"></a>
## Verification

pnpm run test packages/session/session-format-v3-to-v4/tests/attribution.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts: 12 tests passed. Seven focused headless/TypeScript SDK CUA snapshots, the shipped cua-mcp profile expectation, Web CUA replay and Python SDK replay passed. CUA behavior tests cover persisted held notices, confirmed release notices after pause, and removal of delayed stale notices.

<a id="dev-note"></a>
## Dev Note

None.
