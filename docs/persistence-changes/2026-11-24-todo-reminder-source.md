---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-24-todo-reminder-source

English | [中文](2026-11-24-todo-reminder-source.zh.md)

## Summary

Adds the todo-reminder message producer kind using snapshot form and bounded reminder text.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-24-todo-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-19-plugin-reference-source"
    after: "a6ad7b1b4ecb39b6c2c6ba801bff9d2601e990acf846db7217350fab6d05fea8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-19-plugin-reference-source"
    after: "1fa784dd2338cf16d2641a437ad6f2ae81ad3e2d8e9c8b5f1dd983e1682e2a6f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-19-plugin-reference-source"
    after: "f2aa1a0423acdb256a598c513fb7bb45d86a13a67080ee34f5dcea6289d7396f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-19-plugin-reference-source"
    after: "c234c1ee836693b406782c6dac3abfe3644abc814216ef765ff1bd08682ac1cf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

This remains Session format V4. Current readers retain every existing source kind and event field. Released V4 readers accept nonempty unknown producer kinds in user and developer messages, preserve their snapshot metadata and text, and derive model history normally. The same source objects may occur in queued inbox or title-request messages without altering event discriminators, headers, or existing source meanings.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/attribution.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts (12 tests passed); pnpm exec vitest run packages/todo/tool-todo/tests/ (5 files, 48 tests passed, 100% coverage); pnpm exec vitest run --config vitest.snapshot.config.ts -t todo-update-reminder (1 passed).

<a id="dev-note"></a>
## Dev Note

None.
