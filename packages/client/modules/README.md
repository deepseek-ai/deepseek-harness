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

The application combo scripts carry only each plugin's `client.js` entry and register those factories once during boot; module bodies remain lazy and run only at first import or materialization. A source `import()` split by tsdown compiles to `require.async("./client.<name>.js")`; its versioned sibling script arrives only when that expression runs. Rows that share a combo URL share one in-flight script task. A combo whose `<script>` fails to load is requested once more; a combo that loads without registering a row is never re-executed, because the batch script registers its packages in sequence and a replay would stop at the first duplicate registration. In both cases each still-missing row then loads its own one-resource combo URL, so one failed batch costs at most three requests per missing row and leaves the rows it did register untouched. The module system records the last import failure per row (transport, registration, dependency cascade, or factory execution); the Web boot audit reports that text per entry. HMR switches one changed row to its revisioned one-resource combo URL. `<id>/client` and the bare id resolve to the same exports, because a plugin bundle is its package's client half.

### Live plugin composition

An open Web page follows the Host's complete module graph through the HMR transport. Enabling an ordinary plugin adds its Loader entry; disabling it removes the entry and waits for its asynchronous effects before evicting unused modules and styles. Re-enabling loads one instance with its styles. Other Loader contributors and shared modules still needed by active entries remain loaded. Settings → Plugins → Plugin list shows page-local synchronization failures and offers retry without changing Host enablement.

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

The package has two sides: the Node half is the composition and serving side (`ctx.clientModules`, `ClientModuleRegistry`), the browser half is the loading side (`ctx.modules`, `ClientModuleSystem`). The wire between them is the boot graph — `WebBootEntry` rows injected as `window.__DSH_BOOT__`, with `<` escaped so plugin-controlled strings cannot break out of the script element. The vendored Loader's only consumption point is `EntryTree.import`, so the module system is the single replacement for "how plugin code arrives".

### Lazy-CJS model

Executing a plugin bundle only registers its factory; every module-body side effect (CSS injection included) lives in the factory closure and runs at materialization (`factory(require)` → exports, memoized in `loadCache`). A factory that requires another registered-but-unmaterialized module materializes it recursively; require cycles throw because factory-form CJS cannot deliver partial exports. Resolution checks the platform seed table, memoized records, boot-graph rows, and registered factories in that order; anything else throws. The synchronous `require` uses the same order without asynchronous graph-row loading and records observed edges into the module record. Its `require.async` operation returns a Promise and fetches a compiler-generated package-local chunk before materializing that chunk once. This protocol supports self-contained chunks only: entry and chunk outputs cannot synchronously require another relative `client*.js` output.

### Incremental composition

The Node half scans incrementally per package — no full-rescan path. Every `internal/plugin` emission marks the fiber's entry name dirty; a microtask flush reconciles each dirty name against the live loader entries, and the activation pass seeds the same dirty set and flushes synchronously, so first scan and steady state share one implementation. Package metadata is cached per Loader specifier and owning-tree base URL until restart, while the resolved manifest package name identifies the browser module. Distinct active Loader sources resolving to one package name are rejected; removing the conflict promotes the remaining source without requiring its fiber to restart. Bundle content changes reach the graph only through `rebuilt()` (the HMR hook).

The Node half snapshots each `client.js` entry before publication and creates combo descriptors without building response bodies. It groups resources into combo route keys (`/plugins/??...&rev=...`), with one bootstrap combo for the modules row and one or more application combos for the other rows; each phase is partitioned before a URL exceeds 3 KiB. The graph and batch descriptors carry the app-directory-relative form of the same key (`plugins/??...&rev=...`), which a browser document resolves under its own mount, while the response table stays keyed by the absolute route; the source-map trailer is resolved against the combo script's own directory. A script body is combined once on its first `GET` and ends with its map reference. The corresponding map files are read, validated, and combined separately on the first map `GET`; `HEAD` materializes neither body. The Host does not scan or preload sibling chunks: an exact `/plugins/<package>/client.<name>.js?rev=<rev>` request reads and caches that script, and its map remains uncomputed until the map URL is requested. The chunk reference the browser derives from its owner row is document-relative as well (`plugins/<package>/client.<name>.js?rev=<rev>`), and a chunk script's map trailer is the bare `client.<name>.js.map?rev=<rev>` name, which resolves against the script's own directory. Every combo or chunk map is Indexed Source Map v3 and uses an authored section when available or an identity section for the packaged bundle. Initial publication and HMR derive per-plugin revisions from the entry's `mtimeMs`, `ctimeMs`, and size, without hashing artifact contents. Status-change time distinguishes rewrites that preserve mtime and size. Unchanged artifacts therefore retain their revisions across Host restarts, so SSE reconnection does not replace their browser plugins. The shared preset stamps `client.js` after every package output is written, so a chunk-only rebuild changes the owner revision without a Host-side chunk scan. Combo revisions derive from the ordered row revisions. Advertised combo responses and requested chunk responses remain immutable across unrelated graph recomposition, and an unknown resource or revision returns 404.

### Boot manifest injection

The bundle route follows the injected `webServer` lifetime: it registers when the service is ready and is removed and re-registered when that service is replaced. Module composition and `fetchBundle()` remain available without a Web server.

The host contributes structured index rows that inject, into `<head>`: the `window.__ModuleLoader__` queue facade, advisory preloads for every application combo, the parser-blocking bootstrap combo scripts, then the boot graph before the shell reads it. A Web carrier renders those rows into its index response; a shell-owned carrier can render the same rows without a Web server. The facade's `create()` materializes the modules bundle, delegates construction to its `createClientModuleSystem` export, and leaves the same facade in live-registration mode. The shell installs that returned system as its Loader's `internal`; the modules plugin publishes that instance as `ctx.modules`, so separate Cordis trees never select an instance through module-global state.

### Entry ownership

`ClientEntries` records the entries created during boot and serializes full-graph updates, retries and code reloads over the same Loader. A local generation prevents an older download from mounting after its desired entry or code changes; snapshots of the same targets share the pending load. New arrivals use single-resource URLs, never startup batches that could register existing factories twice. Factories retain their artifact revision before an entry exists; graph updates discard stale unowned factories, their styles and failed arrival targets before importing consumers. Cleanup retains declared and observed transitive module requests from every remaining Loader entry. Its observable status has no runtime library import because the modules bootstrap materializes before platform seeds are available.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: `ClientModuleRegistry`, scan, artifact snapshots, optional combo route, structured index rows |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: bootstrap export, `ctx.modules` enrollment |
| [`src/client/system.ts`](src/client/system.ts) | `ClientModuleSystem`: load/materialize/invalidate machinery |
| [`src/client/entries.ts`](src/client/entries.ts) | Page entry reconciliation, retries and code replacement |
| [`src/client/entry-lifecycle.ts`](src/client/entry-lifecycle.ts) | Loader fiber teardown through the registry and owned-style cleanup |
| [`src/client/manifest.ts`](src/client/manifest.ts) | Wire types, boot-manifest parsing, and the `dsh.client` declaration parser |

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

- **Metadata-based revisions** — revisions identify filesystem generations, not content equality. Metadata-only changes can reload a plugin; changes invisible in mtime, ctime, and size cannot be distinguished.
- **Flat module graph by design** — every bundle is one module node whose edges point only at table leaves; the interface (`loadCache`/`edges`/`invalidate`) already supports a general module graph, so the externalization granularity can change without an interface change.
- **Bootstrap and code replacement limits** — the page retains its modules bootstrap and static platform identities. Removing or replacing the bootstrap requires a page reload; live replacement requests report a page-local error while retaining its fiber and exports; replacing package code and all existing consumers is outside ordinary enable/disable synchronization.
- **Lazy delivery retains requested bodies** — the Host holds each bundle and lazy response plan; a script or map body remains cached after its first `GET`, and HMR additionally retains one prior startup generation. Memory grows only for response bodies that clients request while preserving one-generation race tolerance.
- **An unrequested prior-generation map reads the current map file** — combo revisions track executable bundles, not debug artifacts. If HMR rebuilds a map before the retained prior URL receives its first map `GET`, that response uses the current authored map with the prior bundle offsets; requesting the map before the rebuild fixes that URL's response.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
