---
description: "Client module system for the web GUI: the host composes the boot graph and serves plugin bundles, and the browser loads them lazily, for users and maintainers composing or debugging client plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-modules

English | [中文](README.zh.md)

## Summary

`dsh-client-modules` turns a plugin package's `dsh.client` declaration into a loadable browser bundle: the host half scans enabled Loader entries and composes the boot graph, an available Web carrier serves each bundle over `/plugins`, and a shell-owned carrier dispatches the same exact bundle responses through `fetchBundle()`. The browser half loads those bundles lazily on demand. Plugin bundles execute lazily — running a bundle only registers a factory, and module side effects run at materialization — so nothing runs until a plugin is first used. Everything here is browser-kernel machinery; the model never sees it.

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

Use [`DshClientManifest`](../../util/package-manifest/README.md) for the declaration type. Client-modules validates the JSON and owns the normalized boot graph.

Use it when you compose or build a browser client plugin: the package turns a package's `dsh.client` declaration into a loadable browser bundle with no per-plugin wiring. It activates with the web composition; the shell boots it before any plugin runs.

### Declaring a client plugin

A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`. The host half turns each declaration into a served bundle under `/plugins`, ordered so dynamic providers load before their consumers.

### What the browser loads

The application combo scripts register plugin factories once during boot; module bodies remain lazy and run only at first import or materialization. Rows that share a combo URL share one in-flight script task. HMR switches one changed row to its revisioned one-resource combo URL. `<id>/client` and the bare id resolve to the same exports, because a plugin bundle is its package's client half.

### Sharing modules

The shell seeds a frozen module table (`PLATFORM_MODULES`: React, Cordis, and static UI libraries); every dynamic bundle resolves its externals against exactly that baseline. `dsh.client.external` adds only exact non-baseline requests, each answered by the dynamic package row it names or an exact static-table key. Type-only imports are erased and create no request. Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles.

### Build requirements

The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch; a missing bundle fails activation loudly with one build instruction and a package/path list. Source launch maps host imports to TypeScript source but still consumes the built client export. The package accepts no plugin config of its own.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the module system is built; observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The package is dual-face: the node half is the composition and serving side (`ctx.clientModules`, `ClientModuleRegistry`), the browser half is the loading side (`ctx.modules`, `ClientModuleSystem`). The wire between them is the boot graph — `WebBootEntry` rows injected as `window.__DSH_BOOT__`, with `<` escaped so plugin-controlled strings cannot break out of the script element. The vendored Loader's only consumption point is `EntryTree.import`, so the module system is the single replacement for "how plugin code arrives".

### Lazy-CJS model

Executing a plugin bundle only registers its factory; every module-body side effect (CSS injection included) lives in the factory closure and runs at materialization (`factory(require)` → exports, memoized in `loadCache`). A factory that requires another registered-but-unmaterialized module materializes it recursively; require cycles throw because factory-form CJS cannot deliver partial exports. Resolution checks the platform seed table, memoized records, boot-graph rows, and registered factories in that order; anything else throws. The synchronous `require` uses the same order without asynchronous graph-row loading and records observed edges into the module record.

### Incremental composition

The node half scans incrementally per package — no full-rescan path. Every `internal/plugin` emission marks the fiber's entry name dirty; a microtask flush reconciles each dirty name against the live loader entries, and the activation pass seeds the same dirty set and flushes synchronously, so first scan and steady state share one implementation. Package metadata is cached per Loader specifier and owning-tree base URL until restart, while the resolved manifest package name identifies the browser module. Distinct active Loader sources resolving to one package name are rejected; removing the conflict promotes the remaining source without requiring its fiber to restart. Bundle content changes reach the graph only through `rebuilt()` (the HMR hook).

The node half snapshots each client bundle and available source map before publication. It groups resources into `/plugins/??...&rev=...` combo URLs, with one bootstrap combo for the modules row and one or more application combos for the other rows; each phase is partitioned before a URL exceeds 3 KiB. Every combo map is Indexed Source Map v3 and uses an authored section when available or an identity section for the packaged bundle. Initial per-plugin revisions use process nonces, so startup does not hash every plugin; HMR hashes only an artifact reported as changed. Advertised responses are immutable, and an unknown combination or revision returns 404.

### Boot manifest injection

The host contributes structured index rows that inject, into `<head>`: the `window.__ModuleLoader__` queue facade, advisory preloads for every application combo, the parser-blocking bootstrap combo scripts, then the boot graph before the shell reads it. A Web carrier renders those rows into its index response; a shell-owned carrier can render the same rows without a Web server. The facade's `create()` materializes the modules bundle, delegates construction to its `createClientModuleSystem` export, and leaves the same facade in live-registration mode.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: `ClientModuleRegistry`, scan, artifact snapshots, optional combo route, structured index rows |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: bootstrap export, `ctx.modules` enrollment |
| [`src/client/system.ts`](src/client/system.ts) | `ClientModuleSystem`: load/materialize/invalidate machinery |
| [`src/client/manifest.ts`](src/client/manifest.ts) | Wire types and boot-manifest parsing |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the module contract is not enough: the subsystem reference, the shell that boots the tree, and the client authoring rules behind the graph.

- [Client modules subsystem](../../../docs/subsystems/client-modules.md) — the web plugin table, `WebBootGraph` wire, and the bundle route.
- [Web boot kernel](../web/README.md) — the shell that creates the module system and boots the plugin tree.
- [Client HMR driver](../hmr/README.md) — the reload chain that drives `invalidate`/`prefetch` on rebuilt bundles.
- [Client authoring rules](../AGENTS.md#shared-modules-and-the-module-graph) — the shared-module baseline and `dsh.client.external` semantics.
- [Client group map](../README.md) — the browser half this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as the module loader is browser-side kernel machinery that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the module system does not do. They are current package constraints, not a task backlog.

- **Flat module graph by design** — every bundle is one module node whose edges point only at table leaves; the interface (`loadCache`/`edges`/`invalidate`) already supports a general module graph, so the externalization granularity can change without an interface change.
- **No unload bookkeeping of its own** — style removal and fiber teardown ordering live with the HMR driver (`@deepseek-ai/dsh-client-hmr`); the loader only inventories owned style tag ids per record.
- **Snapshot delivery retains artifact bytes** — the Host holds each bundle, optional source map, generated one-resource response, and current startup combo responses in memory; HMR additionally retains one prior startup generation. Memory scales as several copies of the composed client artifacts in exchange for immutable responses and one-generation race tolerance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
