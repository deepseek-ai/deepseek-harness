---
description: "Plugin market index format 1 validation and install arguments for DSH readers and index generators."
kind: "package-library"
---

# dsh-plugin-market-index

English | [中文](README.zh.md)

## Summary

Validator without runtime dependencies for format 1 of the plugin market index, the single JSON file that lists installable DSH bundles with their display metadata. [The format Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md) defines the document; this package is its executable rule set. DSH's [`dsh-plugin-market`](../../boot/plugin-market/README.md) reads indexes with it, and index generators validate their output with it before publishing.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a library, not a service or plugin: no `ctx`, no registrations, no state, no I/O.

Parse the fetched document as JSON, then pass the value and the URL it was read from to `parseMarketIndex`. The first violated rule throws `MarketIndexError` with the JSON path of the offending value. A successful result drops members the format does not define, fills absent `metadata` groups, `keywords`, `labels`, `sortKeys`, and `engines` with empty values, orders each plugin's `versions` by descending SemVer precedence, and replaces each relative `icon` reference with its absolute URL.

Install one version with `marketInstallTarget(name, version)`: it returns the exact pnpm spec, `name@version` for npm and a commit-pinned `git+https` URL with an optional `path:` parameter for Git, and the registry to ask first when the version names one.

-----

<a id="api"></a>
## API

```ts
import { MarketIndexError, marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
```

| Export | Role |
|---|---|
| `parseMarketIndex(value, indexUrl)` | Validated `MarketIndex`; throws `MarketIndexError` for the first violated rule. |
| `marketInstallTarget(name, version)` | `{ spec, registry? }` that installs that exact version. |
| `MarketIndexError` | Validation failure carrying `path` and `reason`. |
| `MAX_INLINE_ICON_BYTES` | Largest decoded payload of an inline `data:` icon, 32 KiB. |
| `MarketIndex`, `MarketPlugin`, `MarketVersion`, `MarketEngines`, `MarketSource`, `MarketRepository`, `MarketIndexMetadata`, `MarketPluginMetadata`, `MarketDeclaration`, `MarketSortKeyDeclaration`, `MarketInstallTarget` | Validated record types. |

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-plugin-market`, whose `plugin_market` tool returns validated plugins to the model.

#### KV Cache effect

None of its own. The tool result that carries plugins owns its request's cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Generator obligations are unchecked** — the validator cannot verify that `name`, `version`, `publishTimestamp`, `engines.dsh`, or display fields match the package they describe, or that the package declares a bundle.
- **No size bound** — the caller bounds the document before parsing it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
