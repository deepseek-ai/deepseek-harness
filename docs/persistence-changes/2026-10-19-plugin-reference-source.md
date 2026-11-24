---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-plugin-reference-source

English | [中文](2026-10-19-plugin-reference-source.zh.md)

## Summary

Adds a plugin-reference user-message source kind for Host-injected plugin context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-plugin-reference-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-im-message-source"
    after: "ede7c9c353068b1f761f75715f6f841f4a34493debeb54b79f5848b06a3a744d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-im-message-source"
    after: "cf503956dd1c5565f479a550432145645a7254976433dbd9a908e03db71e1772"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-im-message-source"
    after: "34354693fcf6237a2c5c308a36e81a4b9eb3d4fca4f868b84007dc5fc006e43a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-im-message-source"
    after: "c03b621ad0efe814b17f12908d209eba79c250c03b0ceabea0a706496553b564"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. Message sources are an open map; readers that do not know plugin-reference treat the message by role and content and do not need its metadata. New writers emit it only for the one context message appended after a citing user message, and no existing record changes meaning.

<a id="verification"></a>
## Verification

npx vitest run packages/boot/plugin-manager/tests/plugin-reference.spec.ts: 12 tests passed; npx vitest run packages/client/ui-plugin-manager/tests/plugin-reference.client.spec.tsx: 10 tests passed; pnpm run test:gui: 10799 tests passed; pnpm run typecheck: 5 gates passed.

<a id="dev-note"></a>
## Dev Note

None.
