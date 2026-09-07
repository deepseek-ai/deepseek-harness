---
description: "Build-static first-party Session format codec and adjacent migration assembly for persistence readers."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-catalog

English | [中文](README.zh.md)

## Summary

`dsh-session-format-catalog` gives persistence one deterministic Session format reader without consulting mounted plugins. It assembles the frozen v0, v1, and v2 codecs with the adjacent v0-to-v1 and v1-to-v2 edges, checks the complete gap-free chain at module initialization, and exposes physical dispatch, header-only classification, single-pass row restoration, and current record encoding through `sessionFormatCatalog`.

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

Import this library from persistence and test-support readers that need the complete first-party released-format inventory before any feature plugin mounts. Feature compositions do not register or reorder its entries. No runtime invariant companion is published because construction rejects an invalid static inventory and each completed restore validates its result; mutable row-decoder state belongs to one caller-owned streaming restore.

### Entry point

```text
const descriptor = sessionFormatCatalog.readHeader(physicalHeader)
const restore = sessionFormatCatalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' })
for (const row of physicalRows) restore.decodeRow(row)
const current = restore.finish()
const headerRecord = sessionFormatCatalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
const eventRecords = current.events.map(sessionFormatCatalog.encodeCurrentEvent)
```

Import `sessionFormatCatalog` from the package root. JSONL and fixture readers create one restore, push each parsed physical row through `decodeRow()`, and call `finish()` once. Writers serialize the returned current artifact through `encodeCurrentHeader()` and `encodeCurrentEvent()`. Listing calls `readHeader()` and never opens event bodies.

Production historical reads select `{ recovery: 'recoverable', validation: 'transformed' }`. Worker and fixture verification select `{ recovery: 'strict', validation: 'current' }`. Transformed validation runs the released-current rules after migration but deliberately skips installed semantic validation for input that is already current.

The catalog contains all supported historical readers directly. A profile cannot add, remove, or reorder an edge by mounting a feature plugin. Its peer dependency on `dsh-session` supplies the installed current event vocabulary and current restoration rules, while historical edge validators remain frozen.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/generated.ts`](src/generated.ts) is the static owner of codec and edge ordering. [`src/current.ts`](src/current.ts) delegates final header, envelope, message, surface, seed, and current request-header validation to the installed Session semantics. The low-level constructor rejects duplicate codecs, duplicate edges, gaps, and entries beyond the current version before any Session read can begin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Migration machinery](../session-format/README.md) — catalog construction and dispatch behavior.
- [Released v0 to v1 edge](../session-format-v0-to-v1/README.md) — codec and validator ownership.
- [Released v1 to v2 edge](../session-format-v1-to-v2/README.md) — Assistant stream embedding and cardinality-changing reference remapping.
- [JSONL persistence](../session-persistence-jsonl/README.md) — immutable generation naming and exclusive publication.

-----

<a id="model-experience"></a>
## Model Experience

### Catalog dispatch

#### What the model sees

Nothing directly. The catalog only restores the `SessionEvent` history consumed by request reconstruction.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect; restored history determines cache identity in its consumer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **First-party build inventory only** — external migration ownership and distribution are not supported.
- **Generated ordering is closed** — runtime plugin registration cannot supply a missing historical edge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
