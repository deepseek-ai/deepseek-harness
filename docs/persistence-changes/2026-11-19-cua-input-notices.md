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
    previous: "2026-11-05-timeline-priority-notice"
    after: "0880996d224033d9a668528f51edf5f229d9b07dda42fb65f7d1cc1150c12836"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3a6f3e4354a90287bb3a1fb19e7a2f643cdbd7c6472c865abd11f8fa2d3358d5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "4e81b0490558b80c87cd09b214cd958ce0df1bf2bb431c930ff8fd441a8d1df5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "507043f63e859f272ce78f6bc65a7361ee087e5e06301f9c100302230bc887a7"
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
