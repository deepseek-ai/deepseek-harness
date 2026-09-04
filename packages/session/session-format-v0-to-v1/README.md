---
description: "Frozen released-v0 Session header, event, and packed-row decoder with the identity conversion to v1."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v0-to-v1

English | [中文](README.zh.md)

## Summary

`dsh-session-format-v0-to-v1` decodes the complete released-v0 JSONL record language and converts it into the shared-layout v1 format. The edge preserves validated header and event facts except for `version: 0` becoming `version: 1`; it also applies the finite legacy normalizers that v0 persistence accepted. The package freezes the v0 reader, the strict v1 migration target validator, and a vocabulary-neutral v1 physical codec that a later edge can reuse without importing the latest Session representation. Most of its source is the frozen released v0/v1 event vocabulary rather than the identity conversion: `payload-validation.ts` and `relationships.ts` pin the payload members and lifecycle pairings of every first-party event type, so a malformed historical log is refused as an unsupported migration with its source retained before the installed current restorer runs, and a later edge that restructures released events can trust their shapes without importing the current Session package.

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

Persistence obtains this edge through `dsh-session-format-catalog`; feature compositions do not mount it. Import it directly only when assembling or testing the static released-format catalog. No runtime invariant companion is published because every codec and migration call validates its complete source or target artifact and retains no runtime state.

### Entry point

```text
const decodedV0 = releasedV0SessionFormatCodec.decodeArtifact(header, rows)
const migratedV1 = sessionFormatV0ToV1.migrate(decodedV0)
```

`releasedV0SessionFormatCodec` reads the exact v0 header and physical rows, including packed assistant deltas and range-encoded provenance. `sessionFormatV0ToV1` normalizes and strictly validates a complete detached artifact. `releasedV1SessionFormatCodec` preserves the v1 physical layout without freezing the ordinary event vocabulary; the catalog restores current events against the installed Session package.

The alpha edge refuses every event type outside its frozen inventory, including an unknown event marked `ignorable: true`. It also refuses unexpected payload members. `tool/result.meta` and nested PTC `arguments` remain explicit opaque JSON fields and are preserved without Session-sequence interpretation. Unknown content-block `type`, message-source `kind`, assistant finish-reason `kind`, and `turn/end` reason `kind` arms remain owner-opaque JSON while their known arms receive structural validation.

The bounded historical normalizers convert `steering/message` to `user/message`, remove `turn/start.trigger`, convert retired `turn/end` reasons, add the current message wrappers and deterministic legacy message ids, and remove the obsolete `request/header.header.messagePrefix` duplicate. Retired `request/header-delta`, `mode/set`, and the `request/header` fallback reason refuse migration. No other event, reference, source, or payload fact may change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The physical codec expands each packed row atomically and never mutates parsed input. Recoverable decoding rolls back a complete faulty row and keeps the preceding prefix unless a later decoded `turn/end` proves that the faulty region was committed. The migration validates the frozen payload disposition before changing the header version and validates the exact v1 target again.

| File | Role |
|---|---|
| [`src/codec.ts`](src/codec.ts) | Frozen v0/v1 physical headers, packed rows, and provenance ranges |
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
