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
    previous: "2026-11-05-timeline-priority-notice"
    after: "d6d06328af1c9b5a8a763de75c8f95b3bdf15a67f9f5ae2c18401c80572f4ddf"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "ee21b73a2ccee9a6a23640ead31553551776d82ad5c47679b7f468bf9889d3f9"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "265c4bb3701a47b57cc9cede8a66e7056522b7546a5c9cb97938e44a6b1898df"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "c68fa14948985fdc23004a95480ba96eab26cb08b82736425f9f9cd053e3ba2f"
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
