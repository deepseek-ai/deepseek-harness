---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-ptc-operation-metadata

English | [中文](2026-10-05-ptc-operation-metadata.zh.md)

## Summary

Adds optional pure presentation metadata to persisted nested PTC tool results so history retains operation-time directories and file targets.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-ptc-operation-metadata
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-16-session-format-v4"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing tool/ptc-dispatch records without meta remain valid. The optional JsonValue field does not change canonical program values, model-visible content, tool identities or message ordering. Historical calls without a recorded relative target keep safe unavailable navigation. The writer and accepted baseline stay at V4.

<a id="verification"></a>
## Verification

963 focused tests passed with per-file 100% coverage of the six affected runtime/UI sources; actual nested shell and relative filesystem regressions, frozen metadata controls, TypeScript SDK 45 tests, Python SDK 29 tests and three owning keyless refresh/replays passed.

<a id="dev-note"></a>
## Dev Note

None.
