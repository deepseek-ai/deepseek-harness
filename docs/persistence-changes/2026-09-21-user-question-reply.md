---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-user-question-reply

English | [中文](2026-09-21-user-question-reply.zh.md)

## Summary

Adds a qualified user-question-reply message source for a late answer to a continued ask_user_question call.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-user-question-reply
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "6178f1edcb23f361f2a6cb2c859b1c2187220d5695ece4a3400e0d92845a7178"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "186159f5f6f67a0b8cd095b8fe55bef42d4f25ca1a1c248f859867af2ece0467"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "ae84c5e493f94acc63cfb70389073ba616ed7ae7aa4fadde048bdcc64d49bb46"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "b83ed1b1cfffbd7bd5cca06ea72e44be57beb68b39e5a96660ce42a9e21aa411"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such source and remain valid. The new source is qualified attribution on an ordinary user message; readers without dsh-user-questions preserve the message and derive history from its content. Only the userQuestions projection reads this source to close the named question and record its answers. The answer RPC is its only producer and writes outcome answered; closing the Client panel persists no reply. No event type or Session header changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/user-questions/tests packages/interaction/tool-ask-user/tests: 81 tests passed. The focused projection, reply, view, and process-group suite passed 70 tests. pnpm run typecheck passed. pnpm run doc-sync passed all 42 gates, including persistence history and translation pairing.

<a id="dev-note"></a>
## Dev Note

None.
