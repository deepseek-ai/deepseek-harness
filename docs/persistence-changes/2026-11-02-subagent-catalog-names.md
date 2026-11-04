---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-subagent-catalog-names

English | [中文](2026-11-02-subagent-catalog-names.zh.md)

## Summary

Adds version 3 of the parent-owned subagent/catalog payload, which records each continuable or parent-delivered external child's name, unique among its creator's children.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-subagent-catalog-names
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-19-external-subagent-catalog"
    after: "d49164d37eab0f0f70fa787c65d887abbea869c010ccb103d717fab3519c3a41"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Version 0, 1, and 2 payloads keep their schemas and meaning; current readers restore them as unnamed children addressed by Session id. New local and parent-delivered external creation writes version 3. Projection stateVersion remains 6: unnamed checkpoints stay usable, and their suffix replay matches full replay with named events. Earlier releases reject the unknown payload version during native V4 admission and catalog projection restoration instead of misreading the entry, so a parent Session that recorded a named child fails loudly rather than losing a child.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent/tests: 495 tests passed, including named catalog restoration, invalid version-3 facts, sibling-unique reservation, cold resume path recovery, and external parent-delivered names. pnpm exec vitest run packages/session/session-format-v3-to-v4/tests: 397 tests passed, including native version-3 admission and rejection.

<a id="dev-note"></a>
## Dev Note

None.
