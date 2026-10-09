---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-title-reasoning-effort

English | [中文](2026-10-07-title-reasoning-effort.zh.md)

## Summary

Records the concrete reasoning effort selected for auxiliary session-title requests.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-title-reasoning-effort
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-10-05-working-directory-attribution"
    after: "b33545b3244861bcbf73b407d24b53402710f5acacab7ae939537e5504a68dc6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new reasoningEffort field is optional. Existing V4 records remain valid and retain their original absence of a recorded effort. Prepared title requests write the resolved effort when the route exposes selectable reasoning; no Session format bump is required.

<a id="verification"></a>
## Verification

Focused LLM, adapter, title-provider, and replay tests passed: 50 files and 1960 tests. The session-title-after-turn SDK snapshot passed with a recorded low effort selected from a route whose default is high.

<a id="dev-note"></a>
## Dev Note

None.
