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
    previous: "2026-10-27-retry-control-input"
    after: "0355c575aca4270bbee7139e96b581f79bbf9d58675e80f4afa57313ccd42348"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "e584c8c8287efccb70b9477e4c62b7e3c8956ae0aa6edd67264d36449013dfdb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "d83988305c43ef6e9f971a1a042d52d5cb6fce07579d5571d5f6511115659faf"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "0afbb0496cb3532810ace398d8e50feef4317fbcb311e9335feb1f76ab34fee3"
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
