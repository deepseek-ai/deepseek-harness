---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-job-session-lifecycle

English | [中文](2026-09-30-job-session-lifecycle.zh.md)

## Summary

Records owned job registration and settlement with one unique JobId, original timestamps, creating tool calls, and producer completion reports.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-job-session-lifecycle
baseline: false
changes:
  - root: "event:job/registered"
    previous: null
    after: "f5520c1d261ca86ea03735799c311a0a9ede8babb588cf0a65422576d2ee0ad1"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "edd37b1e4974af648633014435572089b1e8fb71910468a0767a7e28fdd22abf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds required job event kinds without changing the Session envelope. New JobIds use a kind-prefixed UUID for both live controls and durable pairing; historical sessions receive no fabricated job history. Older builds reject unknown required events. producerReported describes completion-promise fulfillment, not verified resource release.

<a id="verification"></a>
## Verification

Registry and snapshot-normalizer tests cover causal order and unique JobIds. CLI and SDK snapshots verify registration, settlement, and notices during execution; the [job lifecycle contract](../subsystems/jobs.md#session-lifecycle-records) allows incomplete terminal history during application teardown.

<a id="dev-note"></a>
## Dev Note

None.
