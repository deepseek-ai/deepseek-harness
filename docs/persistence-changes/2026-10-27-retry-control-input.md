---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-retry-control-input

English | [中文](2026-10-27-retry-control-input.zh.md)

## Summary

Add the retry message source for empty Session API continuation prompts; ordinary user/message records retain the input identity and caller metadata.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-retry-control-input
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "1682631f010d5ea717d181ed6f4ef46cde08d92a31ab461e7e98edfc98461f85"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "510826cf4e1f9220d75c1efd90b349dd9a77fc5ba15d19e16f87e85a48db5f99"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "3bca25b2baa6b22be9b577621a7603497f40870ed88a8dac4383d37dc2bb6e18"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "50a15408d511e9be3fa93abff37a38ae770f3ab905fc6849fee0d989200d2b97"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The retry source is producer-owned metadata on the existing empty UserMessage representation. AgentLoop, model-history derivation, and SDK prompt behavior are unchanged. Older readers preserve extensible source metadata and consume these messages through ordinary user-message admission; they may display an empty context row. Updated readers retain historical ordinary messages and hide only empty retry messages in Chat. Existing event discriminators and the current Session version remain unchanged; no new required event is introduced.

<a id="verification"></a>
## Verification

The Session API suite passed 1112 tests across 51 files; continuation.ts has 100% statements, branches, functions, and lines. Chat and conversation tests passed 1875 tests across 113 files; final focused Chat and input regressions passed 96 and 31 tests. The browser continuation replay passed with an empty retry user message retained in the log, no empty Chat bubble, and normally closed turns. Build passed all 10 gates, typed lint exited 0, and doc-sync passed all 43 gates. Git comparison against the PR base confirms no AgentLoop, Core Agent, Core Session, or SDK changes.

<a id="dev-note"></a>
## Dev Note

None.
