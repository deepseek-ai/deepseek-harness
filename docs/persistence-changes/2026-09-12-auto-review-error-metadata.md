---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-12-auto-review-error-metadata

English | [中文](2026-09-12-auto-review-error-metadata.zh.md)

## Summary

Adds optional structured error metadata to persisted PTC dispatches and an optional user-facing reason to persisted native tool errors. Both additions retain the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-12-auto-review-error-metadata
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-11-initial"
    after: "b5d66eaebed4da391b13498623b11142222149fbf5e025975dbc6d94f0d06796"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-11-initial"
    after: "3a803805bdeb805f32b229e399fb7258be8e32a89f89063a7c99957cfea942f7"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing tool/ptc-dispatch events can omit error, and existing tool/result errors can omit reason. PTC dispatch events do not enter model history; native tool-result replay projects data.message and does not include error metadata. Older readers can ignore these additions without changing model replay. Current Web readers accept absent reasons and only display Auto review denial details when the recorded error identity matches. Permission mode remains a string in the existing event; selecting auto introduces no declared persistence-type change. No header, event envelope, or existing value type changes, and no adjacent migration is required.

<a id="verification"></a>
## Verification

pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts passed 64 tests. Focused permission, Auto review, tool execution, agent-loop, subagent inheritance, and TypeScript SDK owner tests passed 390 tests across 10 files, including native and PTC denial metadata. uv run --python 3.10 --group test --project python/sdk pytest python/sdk/tests/test_client.py -k preserves_auto_review_errors passed 1 test. The persistence preview classified only the two optional additions and required no version bump.

<a id="dev-note"></a>
## Dev Note

None.
