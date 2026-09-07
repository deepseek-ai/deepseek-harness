---
description: "Pure adjacent Session format planning, lossless JSON value checks, header-only migration, and physical codec dispatch."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format

English | [中文](README.zh.md)

## Summary

`dsh-session-format` lets persistence code restore a current Session directly or compose a unique sequence of adjacent migrations while consuming physical rows once. A restore transfers caller-owned parsed values through stateful stages without intermediate artifact copies or freezing. Physical framing, compression, immutable generation naming, exclusive publication, and Cordis lifecycle behavior remain outside this library.

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

Use this library from persistence or format-catalog code that must classify a physical Session header, restore current logical values, or compose released adjacent migrations. It is not a Cordis plugin and has no profile mount row. No runtime invariant companion is published because each completed operation validates its result; decoder and transformer state belongs to one unfinished streaming restore and is never shared across restores.

### Entry point

```text
const catalog = createSessionFormatCatalog({ currentVersion, codecs, currentEncoder, migrations, restoreCurrent, restoreTransformedCurrent, restoreCurrentHeader })
const descriptor = catalog.readHeader(physicalHeader)
const restore = catalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' })
for (const row of physicalRows) restore.decodeRow(row)
const current = restore.finish()
const headerRecord = catalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
const eventRecords = current.events.map(catalog.encodeCurrentEvent)
```

`createSessionFormatCatalog()` accepts one frozen codec per supported version, the current record encoder, one migration per adjacent version pair, and current artifact and header restorers. `readHeader()` returns a `current`, `migration-required`, `unsupported`, or `malformed` descriptor without reading events. Body readers create one restore, push each parsed physical row through `decodeRow()`, and call `finish()` once for a current artifact. Writers encode its header and events record by record.

The `recovery` option selects strict row failure or recoverable suffix handling. `validation: 'current'` applies all installed current-format validation. `validation: 'transformed'` applies released current-format validation after historical migration, while already-current input receives only its codec's physical validation.

The recoverable decoder returns the accepted logical prefix. A codec may drop one malformed or sequence-gapped row and its uncommitted suffix, but a later decoded `turn/end` makes the original issue fatal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The chain validates unique gap-free ordering at construction. The catalog composes one row decoder with stateful adjacent event transformers, retains only their bounded state and the final current events, and performs target validation at `finish()`; only the caller decides whether and how to publish that result.

| File | Role |
|---|---|
| [`src/chain.ts`](src/chain.ts) | Adjacent plan construction and current bypass |
| [`src/catalog.ts`](src/catalog.ts) | Physical version dispatch and header classification |
| [`src/json.ts`](src/json.ts) | Detached lossless JSON snapshots and common coordinate checks |
| [`src/filename.ts`](src/filename.ts) | Canonical `session[.vN].jsonl` basename shared by persistence, export, and fixtures |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released v0 to v1 edge](../session-format-v0-to-v1/README.md) — frozen historical decoding and identity conversion.
- [Static catalog](../session-format-catalog/README.md) — first-party codec and migration assembly.
- [JSONL persistence](../session-persistence-jsonl/README.md) — durable framing and generation publication.

-----

<a id="model-experience"></a>
## Model Experience

### Session restoration

#### What the model sees

Nothing directly. Consumers reconstruct model history from the validated current artifact through `deriveMessages()`.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect. A migration that changes current history can change the cache identity owned by request reconstruction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Final current history remains resident** — streaming retains only bounded intermediate state, but the returned current event array and any required sequence-remap table remain O(event count).
- **Adjacent integer versions only** — the library does not expose spans, stable event identities, or a general reference-rewrite algebra.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
