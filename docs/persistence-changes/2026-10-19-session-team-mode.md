---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-session-team-mode

English | [中文](2026-10-19-session-team-mode.zh.md)

## Summary

Records the root Session’s Agent Teams selection with the required team/mode event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-session-team-mode
baseline: false
changes:
  - root: "event:team/mode"
    previous: null
    after: "920d87e22b7409bcc7224f8b1dc7f5101c33574c75627c65baab12b85cc96e75"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing V4 logs remain readable. Without a selection, historical tasks enable Team; without historical tasks it remains disabled. Readers predating team/mode refuse the unknown required discriminator, so they cannot silently restore the wrong mode. Ordinary forks ignore inherited mode selections and start disabled. No existing payload or Session header version changes.

<a id="verification"></a>
## Verification

197 focused Team, tool, model-menu and client tests passed; the Web mode and task-board scenario passed 8 tests. The authored team-session-mode headless and TypeScript SDK snapshots exercise on/off commands; Python SDK raw-event projection retains both selections.

<a id="dev-note"></a>
## Dev Note

None.
