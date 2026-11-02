---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-action-card-status

English | [中文](2026-10-22-action-card-status.zh.md)

## Summary

Adds action-card status attribution to logged model context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-action-card-status
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "b36fd842cd004b532ce96fd5d6f5be28e017eda043131aa3cf5e69edc436108e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "5ef58f2a1bdc576c1f12fa1f4da1920ece020b13c0f991a578cddcbeb28bc5be"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "efa1a091017ce533e38b0ef3e14d11a5c102ff1793229b18dad719a4268d9adc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "58b122df513aeaf7ddc5783dbb1fd844e2979bb273964e30ae351a8db6510019"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages and records are unchanged. Readers without the action-card plugin preserve the new action-cards source kind and its JSON metadata and derive the recorded text as ordinary context. Only the producer uses the through sequence, to acknowledge delivered decisions; it grants no authority and does not change replay interpretation.

<a id="verification"></a>
## Verification

pnpm exec vitest run on the action-cards, creation-recommendations, client-ui-action-cards and client-ui-creation-recommendations tests: 120 tests passed with 100% coverage of their sources. The Web creation-recommendations replay logs the status notice of a dismissed card before the next answer.

<a id="dev-note"></a>
## Dev Note

None.
