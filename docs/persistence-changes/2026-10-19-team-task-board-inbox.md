---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-team-task-board-inbox

English | [中文](2026-10-19-team-task-board-inbox.zh.md)

## Summary

Adds the team-task-change message source for shared task-board notices in durable inbox and model-history messages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-team-task-board-inbox
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "4496bd99940ad6dec32f1a181c218c0b9f67a80c2b5c50bcb4ce52e2b4518f18"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "f1709ece9b0e182d8976e81f3bea0ba84fd050ea4636aa75f005cb173e429267"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "267ed256d5fa601fe0a09e9a3a791a7127d9159e5b6caec9f4c075af50dd51b4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b2e4a6ee169963de0dae2a5b6a0855f3a0366e858fa68910a297f035e7ae0a13"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The current reader continues to accept every existing source. Older V4 readers preserve producer-owned source kinds without requiring a known discriminator; team-task-change retains ordinary user-message text and the existing notice form with a summary. Generic notice renderers display it without interpreting rootSessionId. The new source appears in agent/inbox/spliced, user/message, developer/message and session/title-llm-request through the shared MessageSource union. No event discriminator, task payload or writer version changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team/tests packages/experimental/tool-agent-team/tests: 67 tests passed. pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t "team-task-inbox|team-targets|team-tree-messages": 3 scenarios passed, including durable task commits, coalesced notice restoration and an immediate inbox wait.

<a id="dev-note"></a>
## Dev Note

None.
