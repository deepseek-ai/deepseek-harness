---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-action-card-decision-event

English | [中文](2026-11-17-action-card-decision-event.zh.md)

## Summary

Adds the action-cards/decision event, which records action card dismissals and kind progress in place of the experimental plugin record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-action-card-decision-event
baseline: false
changes:
  - root: "event:action-cards/decision"
    previous: null
    after: "492fa1aa4c50b0476e236570fe9865de7959d2a4eeffc044ec47dcedf02909ec"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new root in the same Session format version. Existing logs contain no such event and stay valid; readers that predate it refuse a log carrying it, as every required-on-read event does. Decisions written earlier remain ignorable plugin:action-cards/decision records, and the actionCards projection still reads them, so dismissed and created cards keep their state. The event is appended only when a user acts on a card or a card kind records progress. It is not sent to the model; the status notice that reports decisions is its own user/message event.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/action-cards packages/extensions/creation-recommendations packages/extensions/plugin-recommendations: 110 tests passed, including the projection reading a legacy plugin record.

<a id="dev-note"></a>
## Dev Note

None.
