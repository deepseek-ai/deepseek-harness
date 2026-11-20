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
    previous: "2026-11-18-cua-activity-context"
    after: "ade14698ae6a3d3b0887fa99e4e372c55f6055ed3adee76d6caf00c8904d9980"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-cua-activity-context"
    after: "5a203a0157538ebed5a470dfa959663dcfc183fcd970eae4dff2a019dfa3d07f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-cua-activity-context"
    after: "044055f8b6ff3c8dbb6d8211d3f29aa226e0410d2cffa9b33342a36bec8c1941"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-cua-activity-context"
    after: "49528c3ac96101a8ed51d419f0320d47a35e8ca6b9f8ed1277240ec66d445ff0"
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
