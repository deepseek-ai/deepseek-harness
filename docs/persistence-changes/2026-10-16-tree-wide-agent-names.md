---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Summary

Stores immutable sibling name segments in existing subagent catalog and descriptor records. Full agent paths are derived from parent catalogs and live ancestry.

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
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "194530445ad15cc68b8a708321a4d8d118dfe54600864fcb965ffca9b1afb8cc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept earlier unnamed catalog and descriptor records, using legacy Session-id segments for those children. Earlier strict catalog and descriptor readers reject added name fields instead of interpreting names incorrectly. The unmerged root-only catalog v3 registration variant is removed; published catalog v0–v2 variants and Session ids remain unchanged. The Session writer version stays the same. Catalog projection checkpoints are invalidated by a state-version increment. Only the direct parent records a child; a named child cannot resume without its matching parent catalog entry.

<a id="verification"></a>
## Verification

Focused subagent, control-tool, Team, and V3-to-V4 reader suites pass 1,109 tests. The 10 selected changed implementation files have 100% statement, branch, function, and line coverage. Cases cover sibling-local reservations, repeated segments in separate branches, historical path resolution, parent catalog failure and cold-resume refusal, fork isolation, and rejection of unsupported name-only catalog rows.

<a id="dev-note"></a>
## Dev Note

None.
