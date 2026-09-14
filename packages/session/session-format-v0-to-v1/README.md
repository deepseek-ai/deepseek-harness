---
description: "Frozen released-v0 Session header, event, and packed-row decoder with the identity conversion to v1."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v0-to-v1

English | [中文](README.zh.md)

## Summary

This package restores released v0 Session JSONL by decoding each physical row and producing the shared-layout v1 format. It preserves validated headers and events apart from changing version 0 to version 1, while applying only the finite legacy normalizations accepted by v0 persistence. Malformed or unsupported historical records fail migration before the current restorer runs, with the source retained for recovery. The migration accepts only the frozen first-party event inventory and does not publish or select later format migrations.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Persistence obtains this edge through `dsh-session-format-catalog`; feature compositions do not mount it. Import it directly only when assembling or testing the static released-format catalog. No runtime invariant companion is published because the package has no independently observable runtime registrations whose state can diverge; decoder and migration-stage state belongs to one restore.

### Entry point

```text
const decoder = releasedV0SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
for (const row of physicalRows) decoder.decodeRow(row, migrationContext)
const inheritedEventCount = decoder.finish(migrationContext)
const stage = sessionFormatV0ToV1.createStage(stageInput)
stage.transformEvent(event, migrationContext)
const targetInheritedEventCount = stage.finish(migrationContext)
```

`releasedV0SessionFormatCodec` reads the exact v0 header and physical rows, including packed Assistant deltas and range-encoded source-event references. Its decoder emits either a scalar event or a codec-owned compact run through `emitEvent()` and `emitRun()`. `sessionFormatV0ToV1` creates one stateful stage per restore; the static catalog connects that decoder and stage so migration does not retain a physical-row array. `releasedV1SessionFormatCodec` exposes the same row-at-a-time decoder for the v1 physical layout without freezing the ordinary event vocabulary.

The alpha edge refuses every event type outside its frozen inventory, including an unknown event marked `ignorable: true`. It also refuses unexpected payload members. `tool/result.meta` and nested PTC `arguments` remain explicit opaque JSON fields and are preserved without Session-sequence interpretation. Unknown content-block `type`, message-source `kind`, assistant finish-reason `kind`, and `turn/end` reason `kind` arms remain owner-opaque JSON while their known arms receive structural validation.

The bounded historical normalizers convert `steering/message` to `user/message`, rename `compact/*` events to `compaction/*`, remove `turn/start.trigger`, convert retired `turn/end` reasons, add current message wrappers and deterministic ids for legacy messages, retry chains, and compaction groups, and remove the obsolete `request/header.header.messagePrefix` duplicate. Retired `request/header-delta`, `mode/set`, and the `request/header` fallback reason refuse migration. No other event, reference, source, or payload fact may change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The physical codec validates each packed row atomically, emits it as a compact run, and never mutates parsed input. Recoverable decoding drops a complete faulty row and keeps the preceding prefix unless a later decoded `turn/end` proves that the faulty region was committed. The incremental normalizer retains only message, retry, and open-compaction identities; the catalog performs complete relationship validation on the final current artifact.

| File | Role |
|---|---|
| [`src/codec.ts`](src/codec.ts) | Frozen v0/v1 physical headers, packed rows, and source-event ranges |
| [`src/dispositions.ts`](src/dispositions.ts) | Released-v0 event and payload-member inventory |
| [`src/payload-validation.ts`](src/payload-validation.ts) | Frozen nested payload semantics for every released-v0/v1 event type |
| [`src/relationships.ts`](src/relationships.ts) | Frozen cross-event pairings: turns, steps, tool starts and results, retries, compaction, titles |
| [`src/migration.ts`](src/migration.ts) | Identity edge and legacy normalization |
| [`src/validation.ts`](src/validation.ts) | Exact source and target validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Migration machinery](../session-format/README.md) — pure chain and codec contracts.
- [Static catalog](../session-format-catalog/README.md) — build-owned assembly.
- [Session subsystem](../../../docs/subsystems/session.md) — current logical Session semantics.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Nothing directly. After restoration, `deriveMessages()` sees canonical released-v0 events unchanged under v1; bounded historical forms produce the same model-visible content through their defined current wrappers.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect for canonical v0 history. Bounded normalizers preserve model-visible content while producing current wrappers and deterministic identities.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Closed first-party inventory** — unknown external-plugin events refuse migration in this alpha policy.
- **One adjacent edge** — this package does not perform publication or select later migrations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
