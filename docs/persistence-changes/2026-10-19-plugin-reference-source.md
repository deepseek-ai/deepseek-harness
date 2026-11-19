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
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "ec2dee2e721b44b81c89fe32a39be6b1c1961eb790a0dbe2e40069793460f893"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "3eed4e5f38b6da32f004fb5f3728d7a60cf825af00d0578a6cb4c3cbf2ac820a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "1a44706a633848c4fcd0a32d82546c3519b746817358429d1f919c97a1ddc8aa"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "f61013ef7874a2cc06f4134274e07a3b0491c04a72e36373ec3f85c9bf094eb0"
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
