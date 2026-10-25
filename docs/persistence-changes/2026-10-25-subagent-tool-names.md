---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-subagent-tool-names

English | [中文](2026-10-25-subagent-tool-names.zh.md)

## Summary

Adds the parent-owned subagent-name/bound event for optional named subagent creation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-subagent-tool-names
baseline: false
changes:
  - root: "event:subagent-name/bound"
    previous: null
    after: "2073e98f0c214cc431b1a9a027efe75d22190a8ed8fed2791b47c2b52dd32a57"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing V4 Sessions remain readable and unnamed catalog children retain their Session ids. The new event has a distinct discriminator and does not change subagent/catalog. Older readers without this required event in their vocabulary refuse a Session containing it before adoption; they do not silently discard names or misinterpret another event. The writer format remains V4.

<a id="verification"></a>
## Verification

The subagent-names package tests cover candidate replay, inherited-fork exclusion, checkpoint recovery, duplicate binding rejection, cold parent lookup, and startup failure. The focused storage-contract.spec.ts and V4 codec.spec.ts run passed 37 tests, including refusal of unknown required events before adoption.

<a id="dev-note"></a>
## Dev Note

None.
