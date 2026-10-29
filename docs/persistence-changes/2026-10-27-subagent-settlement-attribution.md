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
    previous: "2026-10-22-action-card-status"
    after: "5f92518a550044ad3ff53f03999a6ed8ae4764e0f015566b455c2f12a0e41dd5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "e70de3d63264af6361a5a4aa05e5e3b135beb18c2d10570591351a49c7e4459a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "081bd58df6366694fc756ec83b60f50d74e480961d8b704d2cce1d78ebe61767"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "d38ac42ecf965f34848ccb4f04e21e79455e1478685b916a152392e74ca5b62b"
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
