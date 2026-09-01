---
description: "Loader integration for generated Typert artifacts: how mounted packages automatically contribute their host-face reflection and schemas to the runtime registry."
kind: "package-reference"
---

# @deepseek-ai/dsh-typert-loader

English | [中文](README.zh.md)

## Summary

With `dsh-typert-loader` mounted, every package that mounts in a Loader composition automatically contributes its generated Typert reflection and schemas to the runtime registry — and withdraws them when the package or the plugin unmounts. Packages without the generated export are skipped, so adding the plugin to any composition is safe. An explicit `packages` list covers plugins nested behind another Loader entry, whose fibers carry no resolvable package specifier. It is a Node-only plugin and needs the config-tree resolution anchor to resolve packages.

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

Mount this plugin in a Host Loader composition that loads packages publishing generated Typert artifacts. The registry itself comes from `dsh-typert-registry`; this plugin only discovers and registers.

### Minimal configuration

Load the registry and the loader; the loader defaults to discovering every Loader entry:

```yaml
- name: '@deepseek-ai/dsh-typert-registry'
- name: '@deepseek-ai/dsh-typert-loader'
```

| Field | Default | Meaning |
|---|---|---|
| `packages` | `[]` | Additional package artifacts to register for plugins nested behind another Loader entry; each must resolve from the config tree and export `./typert` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-typert-loader) is the exhaustive source for every accepted field.

### What gets registered

Each qualifying Loader entry contributes its generated host-face reflection and schemas to the runtime registry. Registration follows the entry lifecycle: it is withdrawn when the entry or the plugin unmounts, and a registration whose import settles after both are gone is discarded.

### Observable behavior and failures

Packages without the export are skipped silently. Resolution verdicts and imported manifests are cached for the process lifetime, so adding a `./typert` export requires a restart. A malformed artifact among already-mounted entries fails activation loudly; a later failure is logged per package without preventing unrelated packages from registering. An explicit `packages` entry that cannot be resolved from the config tree, or that lacks the export, fails loudly and names the package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the loader scans, validates, and registers; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The plugin is an incremental scanner mirroring the client-modules node half: every Cordis `internal/plugin` emission marks the fiber's entry name dirty, and a microtask flush reconciles each dirty name against the live Loader entries; the activation pass seeds the same dirty set with all current entries.

### Manifest validation

`validateTypertManifest()` is the module/file boundary: the manifest crosses from a build artifact into the typed registry, so every field is checked. The manifest must name the package that exports it, carry face `host`, hold zod v4 schema instances, and keep well-formed service, event, object, member, type, and documentation records; invocation descriptors must use strict codecs. Every failure names the package and the defect.

### Caching and ownership

Verdicts (resolvable specifier, export presence) and imported manifests are cached per package name and never expire. Registrations are keyed by entry name and withdrawn through the exact `ctx.typert.register()` disposer; in-flight tasks are tracked per entry so a late import cannot register a contribution after its owner is gone.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, scanner, manifest validation, registration wiring |
| — | No runtime invariant companion is published; the Loader entry lifecycle directly owns each exact registry disposer, and integration tests observe registration and removal. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the loader to what it registers and what produces it.

- [Typert registry](../registry/README.md) — the service this plugin feeds.
- [Typert generator](../generator/README.md) — what produces the artifacts the loader imports.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-typert-loader) — the `packages` field declaration and JSDoc.
- [Typert group map](../README.md) — the full type-reflection pipeline.

-----

<a id="model-experience"></a>
## Model Experience

None, as loader integration only registers generated artifacts; consumers own any model-visible projection.

#### KV Cache effect

No direct effect; registration changes reach a request only through a consumer that reads the registry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the loader does not discover or register; they are current package constraints, not a task backlog.

- **Host face only** — discovery imports only the host `./typert` artifact; client runtimes need a separate composition owner before equivalent discovery is added.
- **Explicit entries for nested plugins** — Loader entries are discovered automatically, but plugins nested behind another entry, or not loaded by the Loader at all, need an explicit `packages` entry or direct `ctx.typert.register()` ownership.
- **Cached verdicts never expire** — a package that gains a `./typert` export mid-process needs a restart before the loader registers it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
