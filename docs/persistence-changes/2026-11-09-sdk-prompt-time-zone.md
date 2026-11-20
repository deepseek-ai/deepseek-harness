---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-sdk-prompt-time-zone

English | [中文](2026-11-09-sdk-prompt-time-zone.zh.md)

## Summary

Adds the sdk-user message source: SDK prompts record an optional canonical clientTimeZone on a user source without rpcId.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-sdk-prompt-time-zone
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5509e694e7b11c54a7b7b1730ad09fd46986a1aeaa45a713a69b9247f5861efb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "53538b9e2b974a81f1248a4505482f8ab5c91bdf59b24cb3bd8e908bf8dd278e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5d8b5283839b93371885639068f7df86ab6d3134faf186456bdd4f4bdcb42260"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3a34ff4c0c404f4b674b06d4d567953b4dee24c35dd72b03ee5b89553326bb3a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The kind stays 'user' and the field is optional, so every existing Session log is unchanged; an SDK prompt without a usable zone writes the same { kind: 'user' } source as before. The writer canonicalizes the zone before commit, and request preparation still refuses a noncanonical value. A current reader of an older log finds no clientTimeZone on SDK prompts and reports the zone as unavailable, as before. A reader that predates this change ignores a clientTimeZone without rpcId and also reports the zone as unavailable; the model-visible time context of recorded requests is replayed from its own logged events, not recomputed from the source. The field is not part of any model request: provider adapters read only the model-visible message content. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/sdk/server/tests/time-zone.spec.ts packages/context/time-context/tests: SDK prompts persist the canonical explicit or sampled zone, omit it when the sampled zone is unusable, native commands record none, and an rpcId-free user source contributes its zone to the time context; all tests passed.

<a id="dev-note"></a>
## Dev Note

None.
