---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-28-im-message-source

English | [中文](2026-10-28-im-message-source.zh.md)

## Summary

Adds the attribution-only `im` message source that `@deepseek-ai/dsh-im` writes on the user messages it delivers into a hosted session, so readers can tell external IM input apart from owner input.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-im-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "7b3076b2edd39cbc65d59ccdbdbdf586cd543e9aa894b70fb6cfdbc172aed01d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "02cfeb91a193ce6642c8dfbf892b2bfce40999842fc8c8d1a8c34852f95dd833"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "5c7929f7efc45376cf32cfdb8414f89bd5db63003cafb901c54271cca8eb6dc1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "7995e48c2ead64c21ad85aee5dc56a248529229b33a7b4b29649b9c68c2cba36"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The source carries only its `kind` and the `relay` context form. New readers admit a durable message source by its non-empty producer-owned `kind`, and Session replay derives the message without loading the IM producer. Old readers preserve an unknown producer source kind with its JSON metadata. No reader infers authority from the source: access decisions remain in the live IM service, and logs without IM input are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run scripts/im-persistence.spec.ts: 2 tests passed. They encode and strictly decode released V4 rows, restore them through the current catalog, and derive messages without loading the IM producer, once with an `{kind: 'im', form: 'relay'}` source and once without any IM source.

<a id="dev-note"></a>
## Dev Note

None.
