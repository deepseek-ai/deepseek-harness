---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-deepseek-search-thinking

English | [中文](2026-10-13-deepseek-search-thinking.zh.md)

## Summary

Adds the optional `thinking` member to the logged DeepSeek search request body, recording that the auxiliary search turn disables thinking.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-deepseek-search-thinking
baseline: false
changes:
  - root: "event:web/deepseek-search-llm-request"
    previous: "2026-09-11-initial"
    after: "0c556c9b9f2a96238a6b9bbb99e748206cbff2ed6203041c9571f04ae5802f52"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: absence means the request omitted the field and DeepSeek applied its default. The event is log-only; no reader replays or interprets the body for behavior, and the provider writes the member on every new request.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/web/web-search-deepseek/tests/deepseek.spec.ts: 59 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
