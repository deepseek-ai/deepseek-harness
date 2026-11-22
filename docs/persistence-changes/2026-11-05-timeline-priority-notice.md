---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

English | [中文](2026-11-05-timeline-priority-notice.zh.md)

## Summary

Records a Timeline notice when the user adds or removes urgent priority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-timeline-priority-notice
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "f5d843edb0eeef61c9f5328599d5f92b61112b7710b0310b043196b15b390d64"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "7ee5a828196d9e4b1672f94f977e68f37125da4297c23029dd682823c09e12fd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "4ee17e4219bd5fab6148ec0a8b3ec0fb939edb8f211374cf779bc8135ef9bed2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "fb6a6e338625067ac582f55dde412a583040cd738bb8fc6820cb0b941c59f05a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages keep their source and meaning. Timeline notices carry ordinary text and a source label. Readers without Timeline can keep the unknown source and read the text without applying a task update. Timeline stores task trees, reports, and discussions in the session log as ignorable `plugin:timeline/*` records. Readers without Timeline skip these records.

<a id="verification"></a>
## Verification

Timeline's priority tests check that only user edits to urgent priority enqueue a notice. The process recovery test checks that Timeline state survives an interrupted writer.

<a id="dev-note"></a>
## Dev Note

None.
