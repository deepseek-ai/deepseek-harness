# Client Modules

English | [中文](client-modules.zh.md)

The web plugin table: the Node half of the client module system in [dsh-client-modules](../../packages/client/modules), provided as `ctx.clientModules` (`ClientModuleRegistry`). It scans the host Loader's entries for packages declaring `dsh.client`, composes the `window.__DSH_BOOT__` entry graph, serves versioned one-or-more-resource combo scripts under `/plugins`, and answers every index-injection collection with the boot protocol rows — the four faces of one service. It is an optional capability of the web GUI stack, not part of the agent-loop spine, and it is a consumer of [dsh-host-webserver](../../packages/host/webserver): the carrier described in [web-server.md](web-server.md) supplies the prefix route and the `webserver/index-inject` event this service answers. The same package's browser half (`ctx.modules`, the lazy-CJS module table that fetches and materializes these bundles) is kernel machinery documented in the [package README](../../packages/client/modules/README.md), not here.

Source: [`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts)

## The wire

The graph is the wire single source between the Node and browser halves. The host composes `WebBootEntry` rows and `WebBootBatch` descriptors from scanned packages, then contributes the registration facade, application preloads, bootstrap scripts, and graph global to the structured index-injection table before the Vite entry. The `global` row renders as `globalThis["__DSH_BOOT__"]` with `<` escaped so plugin-controlled strings cannot break out of the script element. A page without a valid manifest cannot boot: the browser parser rejects malformed rows or batches, unknown members, and entries without exactly one initial combo descriptor.

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch. `inject` names package rows whose
 * factories must arrive before this row materializes, while Cordis separately
 * uses the same package edges to compose entries. `external` carries exact
 * non-inject module requests (see {@link WebBootGraph.entries}).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Revisioned single-resource combo endpoint used by HMR. */
  url: string
  /** Opaque plugin-artifact revision used for HMR cache busting. */
  rev: string
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

```ts type-equiv
/** Initial scheduling phase for one revisioned combo script. */
type WebBootBatchPhase = 'bootstrap' | 'application'
```

```ts type-equiv
/** One initial combo script; a scheduling phase may span several descriptors. */
interface WebBootBatch {
  /** Parser-blocking bootstrap or preloaded application scheduling. */
  phase: WebBootBatchPhase
  /** Revisioned combo script endpoint. */
  url: string
  /** Revision derived from the ordered entry revisions. */
  rev: string
  /** Graph entry ids whose factories the script registers, in execution order. */
  entries: string[]
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the current entry and batch descriptors. */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
  /** Initial combo descriptors; every entry belongs to exactly one descriptor. */
  batches: WebBootBatch[]
}
```

Each initial row's `rev` is an opaque process nonce plus sequence, so graph composition does not hash every plugin artifact. After HMR observes a bundle change, that row's revision becomes the hash of its new executable bytes. The initial descriptors partition rows into bootstrap and application scheduling phases, and either phase may contain several descriptors. Their URLs contain only the ordered package-resource list and a revision derived from those row revisions; phase names do not enter the route. Graph composition preserves row order while greedily splitting before the map-form URL exceeds 3 KiB, without concatenating scripts or reading maps. The graph revision hashes the entry and batch descriptors. `immediately` marks the stage-one registration barrier; rows within one combo share its script transport, while separate combos load independently.

## The scan

A package joins the table by declaring `dsh.client` (`platform: 'web'`, optional `inject` edges, optional `immediately`) in its package.json and exporting its built bundle at `exports["./client"]`. Each live row resolves from its own Loader specifier and owning-tree `baseUrl`, through the same `loader.internal.resolveSync` implementation that imports its Host face when available. The nearest owning package manifest supplies the browser module id, so relative source and built overlays retain the package identity. Distinct active Loader sources resolving to one package name fail composition; after one source unloads, the surviving source supplies the row without a fiber restart.

Scanning is incremental per package; there is no full-rescan code path. Every cordis `internal/plugin` emission (fiber construction or disposal) marks the fiber's entry name dirty, and a microtask flush reconciles each dirty name against the live loader entries. The activation pass seeds the same dirty set with all current entries and flushes synchronously, so first scan and steady state share one implementation — with opposite failure postures. At activation, a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud `AggregateError` listing every broken package: the fiber FAILS and the boot's fail-loud sweep reports it. In steady state, a broken package logs a warning and must not poison the others.

Package metadata — including the negative "not a client package" verdict — is cached per Loader specifier and owning-tree base URL until restart. A fiber restart from the same source reuses its row and rev untouched; bundle content changes reach the graph only through `rebuilt()`.

## The bundle route and index injection

`GET`/`HEAD /plugins/??<package-a>/client.js,<package-b>/client.js&rev=<rev>` addresses one generated combo script; a one-resource request uses the same form and is the HMR path. The script is concatenated once on its first `GET` and ends with an absolute `sourceMappingURL` whose resource suffixes are `.js.map`. The map files are not read by startup, index rendering, script `GET`, or `HEAD`; the first map `GET` reads and validates them, composes one Indexed Source Map v3, and caches that body. An authored component map supplies its section; a component without one receives an identity section whose `sourcesContent` is the captured bundle and whose source name is its packaged `sourceURL` or plugin route. Every startup request URL is at most 3 KiB measured as UTF-8 bytes; partitioning uses the longer map form. All application URLs are preloaded, and all bootstrap URLs execute before the graph global and Vite entry. Materialized responses use long-lived immutable caching. Unknown or altered resource lists, missing revisions, and stale revisions answer 404 rather than serving different bytes or letting the SPA fallback return HTML as JavaScript; other methods are 405. The injection rows carry the current graph on every index render, so a reload always boots against the live composition.

## The service

```ts type-equiv
/** Filesystem baseline captured before a client artifact snapshot is read. */
interface ClientArtifactBaseline {
  /** Absolute path of the client bundle. */
  readonly path: string
  /** Bundle modification time in milliseconds. */
  readonly mtimeMs: number
  /** Bundle size in bytes. */
  readonly size: number
}
```

`ClientModuleRegistry` (`ctx.clientModules`, defined in [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)) exposes reads and the rebuild face; signatures are in the generated [service catalog](#ctxclientmodules--clientmoduleregistry). `graph()` returns the current composed graph (a stable object between changes), `clientPath(id)` returns the bundle's absolute path, and `artifactBaseline(id)` returns the bundle stat values captured before the current snapshot was read. `fetchBundle()` resolves the same lazy response used by the HTTP route. `rebuilt(id)` is the only entry point through which changed bundle content reaches the graph: it re-hashes the bundle bytes, and only a real revision change recomposes the graph and notifies. `onRebuilt` fires per changed bundle with the new revision; `onGraphChanged` fires after any flush that recomposed the graph (row added or removed, or a rebuilt revision change) and is pull-model — listeners re-read `graph()`. Both notification paths contain listener exceptions so one throwing subscriber cannot skip later subscribers or kill whatever triggered the flush.

[`dsh-client-hmr`](../../packages/client/hmr/README.md) delivers live graph snapshots in the shipped Web composition. The Host forwards existing graph-change notifications immediately, and reconnect sends the current full graph. A graph describes desired browser entries without asserting that Host cleanup has completed. Its artifact poll separately reports rebuilt revisions. Source-map changes alone do not trigger a reload; a new combo-map URL appears only after a bundle revision changes, and each map body is fixed by its first `GET`. Client Modules validates snapshots and serializes reconciliation with those rebuilds; it owns the boot-created entry map, single-resource arrivals, asynchronous removal, unused-module/style cleanup and page-local retry status. Static platform modules and the bootstrap retain their page lifetime; Electron installation is a separate flow.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

The web plugin table service: incremental `dsh.client` scan + wire composition + bundle route + index injection rows. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Current composed entry graph (stable object between changes).
 * @returns the graph served as `window.__DSH_BOOT__`.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Serve an advertised revisioned bundle or source map without a Web server.
 * Unknown URLs return 404, unsupported methods return 405, and `HEAD`
 * returns the same immutable headers without materializing a body. Each body
 * is built once on its first `GET`; script construction never reads maps.
 * @param request - shell-carrier request for a `/plugins` resource.
 * @returns the exact response also exposed by the optional Web route.
 */
async fetchBundle(request: Request): Promise<Response>

/**
 * Filesystem baseline captured before an entry's current bytes were read.
 * HMR compares it with the live files when installing a watch, so a write
 * between startup composition and watch installation cannot disappear into
 * the watcher's initial state.
 * @param id - entry id (package name).
 * @returns the path and baseline, or undefined for an unknown id.
 */
artifactBaseline(id: string): ClientArtifactBaseline | undefined

/**
 * Publish one completed bundle generation (the HMR watch's registration
 * hook — the only entry point through which build changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)
<!-- END GENERATED cordis-surface -->
