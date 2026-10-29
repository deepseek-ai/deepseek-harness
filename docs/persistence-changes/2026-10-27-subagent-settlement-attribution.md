---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-subagent-settlement-attribution

English | [中文](2026-10-27-subagent-settlement-attribution.zh.md)

## Summary

Adds optional stopReason attribution to persisted subagent settlement notices while keeping the Session format version unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-subagent-settlement-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "ddce54a3873dc57113b0cd38ad9b23b3c259186139e8847e5e5f415d86f52482"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "70ea8e7943c5e2d76905bcc2e694e8c3d5b138aaae3609f3e261b8d369a6e35a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d95c624eddecdacf1ee74356196c09d2f3fcd625714be5e852a6b643fa12a7ca"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "dcb07e04496586d2664d72dab0e94312917da56927b2a0dc3ee53d6a33e32450"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept historical notices without stopReason and must not infer it from the English summary. Writers always record the exact captured execution stopReason. Older readers preserve additional source metadata and continue using the existing kind, notice form, summary, senderSessionId, and unchanged content; native V4 source admission validates the producer kind rather than rejecting additional attribution fields. The new metadata affects presentation only, not replay, authority, or recovery. No migration or Session version bump is required.

<a id="verification"></a>
## Verification

Focused Vitest runs passed: continuation-messages.spec.ts (14 tests), external-activation.spec.ts (19 tests), continuation-messages-adapter.spec.ts (1 test), and continuation.spec.ts (166 tests), all under packages/subagent/subagent/tests. Command: node node_modules/vitest/vitest.mjs run followed by the listed owner paths. Coverage includes all five terminal reasons, historical attribution without inference, external cleanup failure retaining the captured execution reason, cold resume, and unchanged DeepSeek Messages wire content. Historical Session generations remain unchanged; affected current-format snapshot expectations include stopReason.

<a id="dev-note"></a>
## Dev Note

None.
