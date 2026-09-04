---
description: "Pure adjacent Session format planning, lossless JSON snapshots, header-only migration, and physical codec dispatch."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format

English | [中文](README.zh.md)

## Summary

`dsh-session-format` lets persistence code restore a current Session directly or compose a unique sequence of adjacent whole-artifact migrations. It snapshots every durable input and output as detached lossless JSON, validates exact version progress, and keeps header-only listing separate from body reads. Physical framing, compression, immutable generation naming, exclusive publication, and Cordis lifecycle behavior remain outside this pure library.

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

Use this library from persistence or format-catalog code that must classify a physical Session header, restore current logical values, or compose released adjacent migrations. It is not a Cordis plugin and has no profile mount row. No runtime invariant companion is published because every operation validates its borrowed artifact before returning and retains no cross-call mutable state.

### Entry point

```text
const catalog = createSessionFormatCatalog({ currentVersion, codecs, encodeCurrentArtifact, migrations, restoreCurrent, restoreCurrentHeader })
const descriptor = catalog.readHeader(physicalHeader)
```

`createSessionFormatCatalog()` accepts one frozen decoder per supported version, the current format's encoder, one migration per adjacent version pair, and current artifact and header restorers. `readHeader()` returns a `current`, `migration-required`, `unsupported`, or `malformed` descriptor without reading events. Each edge validates its target header before the final current-header restorer runs. Body readers call `decodeArtifact()` or `decodeRecoverableArtifact()`, then `migrate()`; writers call `encodeCurrent()` only with a validated current artifact. Frozen v0/v1 codec exports retain their format-specific `packChunks` option without adding that historical control to the current writer or common decoder interface.

The recoverable decoder returns the accepted logical prefix. A codec may drop one malformed or sequence-gapped row and its uncommitted suffix, but a later decoded `turn/end` makes the original issue fatal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The chain validates unique gap-free ordering at construction. A current artifact bypasses every migration callback and passes through only the current restorer. An old artifact runs each adjacent whole-document function in memory; only the caller decides whether and how to publish the final result.

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

- **Whole-artifact memory use** — supported migrations materialize the complete logical Session; streamed transformation is deferred until measured artifacts require it.
- **Adjacent integer versions only** — the library does not expose spans, stable event identities, or a general reference-rewrite algebra.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
