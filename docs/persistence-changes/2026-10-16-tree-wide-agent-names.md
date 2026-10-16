---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Summary

Records immutable tree-wide agent names in the root Session.

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
  - root: "event:subagent/named"
    previous: null
    after: "273f07aea05d56ffbb8b43508bcfb4a20cce230819feadb3fe740bceb8b12ca6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept older Sessions without assignments and expose stable legacy addresses. Older readers reject the new non-ignorable subagent/named discriminator instead of silently losing identity; existing catalog records and Session ids are unchanged. No writer format bump is needed.

<a id="verification"></a>
## Verification

The names.spec.ts and tool-team.spec.ts tests passed (33 cases); names.ts reached 100% statement, branch, function, and line coverage. Headless and TypeScript SDK replay exercised named creation, messages, discovery, and completion.

<a id="dev-note"></a>
## Dev Note

None.
