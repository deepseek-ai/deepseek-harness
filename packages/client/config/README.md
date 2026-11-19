---
description: "Types of browser-synced plugin configuration"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-config

English | [中文](README.zh.md)

## Summary

The types a browser plugin uses to read its live Host configuration. A plugin declares its Config once, with a Host schema; its Client face receives the top-level volatile fields as a `SyncedConfig` through `apply` and reads other packages' synced Config through `ctx.config`. This package holds types only; [Client Modules](../modules/README.md#synced-plugin-configuration) projects, delivers, and updates the values.

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

A plugin package lists this package in `devDependencies` and imports from `@deepseek-ai/dsh-client-config/types` with `import type` only:

| Type | Use |
|---|---|
| `SyncedConfig<C>` | The `apply` config of a Client face whose shared Config type is `C`: one `SyncedConfigRef` per top-level `Volatile` field. Every field may read `undefined` (a secret, an unprojectable value, or a Host build not yet matching the browser code), so the plugin handles the absent value at each read |
| `SyncedConfigRef<T>` | One field: `get()` reads the current frozen value as the Host reads a volatile reference, and `getSnapshot` with `subscribe` make it the observable source injected into a slot's `hooks` compartment. It has no write operation |
| `SyncedConfigValues` | The JSON values of one plugin's synced fields, as graph rows carry them |
| `SyncedConfigService` | `ctx.config.resolveConfigByPackage<C>(packageName)`, a read-only lookup of another package's current activation object; importing the types also declares `ctx.config` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package exports types through `./types` and both faces, and its Host and Client `apply` register nothing. Client Modules implements every type: the Host face projects values into graph rows, and the page entry controller hands each plugin activation its object and provides `ctx.config`. Plugins therefore depend on these types instead of on the bootstrap Client Modules package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Note: browser plugin configuration sync](../../../.agents/notes/implemented/architecture/2026-11-15-client-config-sync.md)
- [Client Modules synced plugin configuration](../modules/README.md#synced-plugin-configuration)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package declares browser configuration types and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `resolveConfigByPackage` trusts the caller's Config type argument; a wrong type is not detected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
