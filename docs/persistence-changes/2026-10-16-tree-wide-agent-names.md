---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Summary

Stores immutable tree-wide agent names in existing subagent catalog and descriptor records, with catalog v3 registering descendant names at the root.

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
    after: "c97a3640f72bd16b03b788c27630c9423483175b3da4e4e2f22c215c0756d789"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "194530445ad15cc68b8a708321a4d8d118dfe54600864fcb965ffca9b1afb8cc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept earlier unnamed catalog and descriptor records. Older catalog readers reject added name fields and the v3 name-registration variant through strict schemas; older descriptor readers reject unknown name fields. The catalog version discriminator prevents registration rows from being interpreted as direct children. Session ids, event types, and the Session writer format remain unchanged. Catalog projection checkpoints are invalidated by a state-version increment. Root registrations retain names after settlement; failed registration may leave a parent discovery fact, which named discovery and cold resume exclude.

<a id="verification"></a>
## Verification

Focused subagent and Team tests exercise concurrent reservation, root-only lookup with unavailable historical branches, root registration failure after parent publication, retry with a fresh child id, discovery filtering, cold-resume refusal, fork isolation, and repeated child-id rejection. Catalog tests check the new variant, checkpoint parsing, and exclusion from direct-child views; Team projection tests exclude name-only rows.

<a id="dev-note"></a>
## Dev Note

None.
