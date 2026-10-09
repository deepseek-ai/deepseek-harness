---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-19-external-subagent-catalog

English | [中文](2026-09-19-external-subagent-catalog.zh.md)

## Summary

Add external mode to parent catalog entries for children without a local Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-external-subagent-catalog
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-20-unknown-child-catalog"
    after: "53750b9abf61efb7992b0aadc3e247ec927449c63266df28230fd1139f5590ac"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing version-0 and version-1 one-shot and continuable facts remain valid; version 1 also retains unknown mode. New external executions write payload version 2 with mode external, without a separate marker. Creation writes one membership fact; execution and cleanup do not update it. Duplicate child ids remain invalid. This does not change released generations or the Session format version.

<a id="verification"></a>
## Verification

Focused catalog, external activation, native V4 restoration, client navigation, and control-tool tests passed. They cover external membership, historical local modes, invalid marker rejection, non-navigable external leaves, and duplicate-child rejection.

<a id="dev-note"></a>
## Dev Note

None.
