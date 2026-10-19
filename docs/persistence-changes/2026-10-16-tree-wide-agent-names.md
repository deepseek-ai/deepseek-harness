---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Summary

Stores immutable sibling name segments in existing subagent catalog records. Full agent paths are derived from parent catalogs and live ancestry.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-tree-wide-agent-names
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-19-external-subagent-catalog"
    after: "8521c4e8b3ddb8a7835fe8e707061bf4a9a52b9e4c2e98e5fc5fef2ac4998ff3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept earlier unnamed catalog records, using legacy Session-id segments for those children. Earlier strict catalog readers reject added name fields instead of interpreting names incorrectly. Published catalog variants and Session ids remain unchanged, and the Session writer version stays the same. Catalog projection checkpoints are invalidated by a state-version increment. Only the direct parent records a child; continuation requires that parent catalog entry.

<a id="verification"></a>
## Verification

Subagent, control-tool, and Team tests cover sibling reservations, automatic naming, repeated segments in separate branches, historical path resolution, parent catalog failure, cold resume, and fork isolation. Native V4 reader tests cover catalog identity validation and unknown extension preservation.

<a id="dev-note"></a>
## Dev Note

None.
