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
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "0c815ede184e032dbe04cf80acef1b69805eec6dc80fad2ab8ecc78dd12d89b5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "a7de6bf0f2e865cb8b3c3cd28b0e1b68682fc546eb182cbea7312a0552d2e267"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "85ffc622d03785ad37dae842e9c8ae04c1b6630faafa03e646e4cbbb3a972497"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "ce12331e75676e8b9b8b979fb867278ce772c51e2c23e038c14745379efb89fb"
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
