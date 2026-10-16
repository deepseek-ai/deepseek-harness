---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-user-rpc-principal

English | [中文](2026-10-13-user-rpc-principal.zh.md)

## Summary

Adds an optional principal to the user-rpc message source for prompts submitted by a caller other than the owner.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-user-rpc-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "0755b7d1128319ba2e389619cbbf2c961ad648882b4e91da7f3e9582cc8a2034"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "97e0162f983c27456ec71269fb4976b1851588b8c1aeac5d071d43e11f95e03c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "79a4c87f8bfb4d6d05cd9952b99210d6a7db3b478c4a01d94b4c50602308c056"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "2ae8594a998c9862a597129e782277bcc518266712a703b5c3161bdf552d13b8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Owner prompts omit the field, so their sources and every existing Session log are unchanged; an absent principal means the owner. A reader that predates the field ignores it and treats the message as an ordinary user message, because the kind stays 'user'. A current reader of an older log finds no principal and treats every message as the owner's. The field is not part of any model request: provider adapters read only the model-visible message content. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/session-controller/tests/remote-access.host.spec.ts packages/subagent/subagent/tests/control.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts: non-owner prompts persist source.principal in agent/inbox/spliced, owner and existing time-zone sources stay byte-identical; all tests passed.

<a id="dev-note"></a>
## Dev Note

None.
