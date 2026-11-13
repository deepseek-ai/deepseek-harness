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
    previous: "2026-11-05-timeline-priority-notice"
    after: "1730344fc2b73b282bc8065cd729388c3454a1966ffc2557bda89c177162f05e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "0f8fa34035bd1a85ca754bafa2471820f0960d6560b9682a3a703f61932f322f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "9bd33bff02f1b5a1fe4b55c2e26210631f03b78f3e641f56cc72d27d59b911f2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8a21956a397f18ddf306b055e199fa9818e102eaf67a82348e7a0e18633287dd"
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
