---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-retry-control-input

English | [中文](2026-10-27-retry-control-input.zh.md)

## Summary

Add an explicit retry control source and the required agent/retry acceptance event, correlated with durable inbox identity, turn, and step.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-retry-control-input
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "a6d8c25f4b2ca2d137672a8a278ee1398df3f3cb60f5d32d8e3007c68299b664"
    decision: same-version
  - root: "event:agent/retry"
    previous: null
    after: "d8dde9629b7323b03c1c3fb0db75d6b72c73666dc0240ab7d3e41b9c0c40fc7c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "92b82e8b7bbb38b3adeb2c07eb76d0f0e0d18c1729808def7004ac2bc9baa583"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "fb28ad7d7aabceb5bda505cf027e0e22354d7f31757337e7e51a4b592feac172"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "c5bbcb3435908af2036df7105883e0a49c30ecc1fae4420aa5c4cf944066eff5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Updated readers continue accepting older logs with no retry controls. Older readers reject the unknown required agent/retry event before treating a retry as ordinary user content. The retry discriminator also distinguishes queued controls from ordinary empty user messages. API and both SDK consumers are updated together; the current Session format version is retained because event and source discriminators prevent unsafe interpretation.

<a id="verification"></a>
## Verification

Source review confirms controls retain existing inbox and turn lifecycle while agent/retry has no model-surface operation. Regression coverage covers repeated retry, input-id correlation, balanced turns, ordinary empty messages, non-empty retry rejection, deduplication, checkpoint replay, browser behavior, and both SDK recovery recordings. Execution is pending post-push validation.

<a id="dev-note"></a>
## Dev Note

None.
