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
    previous: "2026-10-27-retry-control-input"
    after: "b07af8f880b773b29eed29990eeedd84f8fccdcae7225b1c2b5cc61e9ff85e49"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "8ae60ac78f577885d613bd4e0d626eacee5a264173157ffd916a4eab9634740f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "658270d5960087ef3794fa4988838203446b7a57c129d8f7786736487cb48f92"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "897e77386649c13194b34430ffe352a51916a6bbbb7dacf8461044a4926aef15"
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
