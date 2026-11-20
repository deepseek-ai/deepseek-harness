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
    previous: "2026-11-18-cua-activity-context"
    after: "41b562e6d6c59ac22c023d14fa1ae878bfb4573fe1b1dcb021e58ac2ee6bf049"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-cua-activity-context"
    after: "8ecc75abd481f9eadd4bbe834120662d870e07d0ecc889e8631b03be5089e710"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-cua-activity-context"
    after: "64b6ec45d21f5aed32624819c44ba5c918bbe11ca9c464496d9dbe0606dcb829"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-cua-activity-context"
    after: "b9bcecf9562bc66102dad311fff56c8c0e694d39afa17b39f87a7b88992011c8"
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
