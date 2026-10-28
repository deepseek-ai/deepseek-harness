---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-subagent-settlement-attribution

English | [中文](2026-10-27-subagent-settlement-attribution.zh.md)

## Summary

Adds optional stopReason and description attribution to persisted subagent settlement notices while keeping the Session format version unchanged.

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
    previous: "2026-10-22-action-card-status"
    after: "a26f50177e43e7892b52fed205add6a62a3a0649b93a121443d09e1498e1d865"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "00ee56a8408b42c3988c2cca342ce1b1191357ccbb867113aa74662221e453e8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "898ef1afce2be676fa929a4d4767966a3825eca1afd8aa383111b6540b957a3a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "64a07eec513ce4f40a6ae89d916665abfb4f803a9e9bb801f24005098961e333"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept historical notices without either field and must not infer missing values from the English summary. Writers always record the exact captured execution stopReason and include description only when the settled activation's original task label is known. Local activations retain their descriptor label across cold resume; external activations retain the submitted label. Older readers preserve additional source metadata and continue using the existing kind, notice form, summary, senderSessionId, and unchanged content; native V4 source admission validates the producer kind rather than rejecting additional attribution fields. The new metadata affects presentation only, not replay, authority, or recovery. No migration or Session version bump is required.

<a id="verification"></a>
## Verification

Focused Vitest runs passed: continuation-messages.spec.ts (15 tests), external-activation.spec.ts (19 tests), continuation-messages-adapter.spec.ts (1 test), and continuation.spec.ts (166 tests), all under packages/subagent/subagent/tests. Command: pnpm exec vitest run followed by the listed owner paths. Coverage includes all five terminal reasons, unknown and empty descriptions, historical attribution without inference, external cleanup failure retaining the captured execution reason, cold-resume label retention, and unchanged DeepSeek Messages wire content. The persistence classifier reports eight optional-property additions across four event roots with no compatibility-review flag. Historical Session generations remain unchanged; affected current-format snapshot expectations include the new metadata.

<a id="dev-note"></a>
## Dev Note

None.
