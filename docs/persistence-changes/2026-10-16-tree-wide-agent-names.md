---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Summary

Stores immutable tree-wide agent names in existing subagent catalog and descriptor records.

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

New readers accept earlier field-free catalogs and descriptors and expose stable legacy addresses. Older catalog readers reject the added name field through their strict event schema; older descriptor readers reject the unknown field and cannot cold-resume that child. Neither reader silently assigns a different identity. Session ids, event discriminators, and writer format remain unchanged. Existing projection checkpoints are invalidated by their state-version increments. Names remain reserved after settlement; external caller-delivered executions now also publish catalog entries.

<a id="verification"></a>
## Verification

Focused catalog, descriptor, continuation, and Team tests passed. The names and continuation tests exercised concurrent catalog reconstruction, cold name recovery, unreadable historical branches, failed-start release, fork isolation, and repeated child-id rejection; names.ts reached 100% statement, branch, function, and line coverage.

<a id="dev-note"></a>
## Dev Note

None.
