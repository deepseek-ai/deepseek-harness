---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-retry-control-input

English | [中文](2026-10-27-retry-control-input.zh.md)

## Summary

Add the retry message source for empty Session API continuation prompts; ordinary user/message records retain the input identity and caller metadata.

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
    after: "2e0cf9dbeea369bc77843e2ec47b0ebf4542c2ac29523a64f56aab99db49f0ee"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "caad8a860d58ff99ef3576bcb3e484314b1d9d7065b307d14478ec76573ebdec"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "eb0fc09c936ebe3d3f16e17b89143f26ae4eca3bd8277c7518bafab45a29e255"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "0d6dd68f18afee7bc130aeecc3bb76ee4c1ab472472c76f2f935151f9417681b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The retry source is producer-owned metadata on the existing empty UserMessage representation. AgentLoop, model-history derivation, and SDK prompt behavior are unchanged. Older readers preserve extensible source metadata and consume these messages through ordinary user-message admission; they may display an empty context row. Updated readers retain historical ordinary messages and hide only empty retry messages in Chat. Existing event discriminators and the current Session version remain unchanged; no new required event is introduced.

<a id="verification"></a>
## Verification

Source review confirms AgentLoop and SDK files match the PR base. Regression cases cover consecutive failures, request deduplication, normal turn settlement, empty retry-message admission, unrelated empty messages, and replay/live/prepend Chat rendering. Updated behavior checks will run after publication as requested.

<a id="dev-note"></a>
## Dev Note

None.
