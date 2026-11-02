---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-liveshare-share-viewer-principal

English | [中文](2026-10-13-liveshare-share-viewer-principal.zh.md)

## Summary

Adds the LiveShare share-viewer principal, including the Relay-asserted display name when available, to the user-rpc message source of prompts a share reader submits.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-liveshare-share-viewer-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "cdf988172b589b230f2bce868489def1bb575eb0501076ac757a8f369ac5c64e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "70d2acdec1ebcfea56d02f7233ebb9ec0f7f494447fb952884c22c3afdc01d6f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "2e505098f9209e52eebd577f1a6f9d4e773ec4d78987aff28a7c786442b9f54c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "5bb231bc5afdb532a6898a20604e76bf0c1db438bfcdc17d4847dceaddc02451"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The share-viewer variant is written only for a prompt that a LiveShare share reader's Peer submits; owner prompts still omit principal, so their sources and every existing Session log are unchanged. The value carries the share id and the Relay-asserted provider, tenant, and subject ids. It also carries an optional display name when the Relay asserts one, for attribution only; credentials and avatars are never persisted, and authorization still uses the identity triple. Readers that do not know the optional field keep showing the durable subject id. The LiveShare host consumes it in two places: the `agent/pre-step` admission check re-reads the Relay's grant for every entering message whose principal is a share viewer, and rejects the step when that grant no longer holds; the same step records, in memory for that turn only, that the running turn was viewer-started, which confines that turn to the shared tool surface and leaves an owner-started turn on the Session's native tools. That marker is never appended to the Session log and is recomputed from the next admitted step. A build without LiveShare keeps the message an ordinary user message because the kind stays 'user', and a principal kind this package does not drive is left to whoever drives it. A current reader of an older log finds no share-viewer principal and admits those prompts as ordinary input, as before. The field is not part of any model request. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/liveshare/tests/relay-target-admission.host.spec.ts packages/experimental/liveshare/tests/relay-pre-step-admission.host.spec.ts packages/experimental/liveshare/tests/share-host-listeners.spec.ts packages/experimental/liveshare packages/experimental/liveshare-protocol: a share reader's prompt persists source.principal in agent/inbox/spliced, recovered reader input is refused at the `agent/pre-step` admission check, an admitted one enters the model, and a principal this package does not drive is left alone; the optional displayName is persisted for attribution, accepted only as a non-empty string, and missing or malformed values fall back to the subject id; 35 tests passed plus the two-package LiveShare and protocol suites.

<a id="dev-note"></a>
## Dev Note

None.
