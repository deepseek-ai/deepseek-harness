---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-28-im-message-source

English | [中文](2026-10-28-im-message-source.zh.md)

## Summary

Adds the attribution-only `im` message source that `@deepseek-ai/dsh-experimental-im` writes on the user messages it delivers into a hosted session, so readers can tell external IM input apart from owner input.

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
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "9929de430c8059e61d873365ee797edc826db2383d74d428939c065012809369"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "97133c375e49b08688752c70b6cc616ab9456e77bc9dded302125ba5f702527d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "75e30f7e6c43e2e9b3b70b7fad28a5cfa9623fe23adbc8cc1a9e83adad4267af"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "42fe8ccf38cdf5cc1cb3d559044172913b5b77696aee9546949beb329bc6854a"
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
