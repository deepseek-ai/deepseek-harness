---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-14-image-offload

English | [中文](2026-09-14-image-offload.zh.md)

## Summary

Record selected image occurrences with the image/offload event and derive their offloaded marks through the owning plugin's message projection.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-14-image-offload
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-11-initial"
    after: "646c2f1d243d3a78c5bc9305786fb340f5209c48a97e65f2a186cc5195491f3f"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: "2026-09-11-initial"
    after: "c80c89da83c46db7a454f034c10f969e03cfb574859c7316e5bff683f5a14b0e"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-11-initial"
    after: "1169b301aaabcd992657b93ec93750c43175dda81ada5cac086f14f2eaaeed6d"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-11-initial"
    after: "f6f3f30109e9008fccf7da2a3268a63da8646b59dd7cf7b75bcd9cf08ac08a59"
    decision: same-version
  - root: "event:image/offload"
    previous: null
    after: "b222069eea2d768065161c1147b1f2c78c1b54328c84b3586ae5c8f91b8ed35e"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-11-initial"
    after: "525254db03b1d1e6b74cf55aced52817568331ac1f96c0818728910b6692e336"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-11-initial"
    after: "e0b5bf44c27bbfc6ab144239e3e4169c4d21146645e0e3121bbb359c3bc8591d"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-11-initial"
    after: "69becfb6b2d3fd5da91518089454cae8ef33f1835637ec44dde35dd077fd4bae"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-11-initial"
    after: "443371ec07a03a82a0e93d93abca3e70b03bca55ba5b01d507030fcb66e8fbb4"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-12-auto-review-error-metadata"
    after: "b33142af8176323ffbb20762541be81c1d51b60a60887803836e0b146e5bef0c"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-12-auto-review-error-metadata"
    after: "29af48b840d0cd9e48b6f50bf3b354f8f6340607c5b99220a48e74f60beac9e2"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-11-initial"
    after: "bab768260853e13a7cf2e22e65af572a1e76a5b2c01f3cdc2ce09d39b87fb70b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-11-initial"
    after: "314765bdff29c7862fb6ce820f1773563ba3094a680d163ea21180a2591b8578"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs remain readable. The optional offloaded image field leaves unmarked occurrences retained. The new event is required on read: older builds that do not recognize image/offload refuse those logs, and current readers require its message projection. Event envelopes and structural Session format versions are unchanged.

<a id="verification"></a>
## Verification

Session and image-offload tests cover event validation, immutable message projection, missing interpreters, restore, and retry. The focused 1,144-test run and two TypeScript image snapshots pass. The Python advanced SDK recording was refreshed through the built dsh profile and includes the standalone image/offload event.

<a id="dev-note"></a>
## Dev Note

None.
