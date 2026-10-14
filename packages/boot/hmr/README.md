---
description: "Reload plugin code and profile configuration through one coordinated queue."
kind: "package-reference"
---

# @deepseek-ai/dsh-hmr

English | [中文](README.zh.md)

## Summary

Reload plugin source and configuration while an application is running. Module replacements, Include refreshes and profile configuration changes share one queue. Package installation runs outside that queue. Existing Cordis HMR configuration and events remain available under `ctx.hmr`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The base bundle enables HMR with `root: []` when the launcher supplies `profileContext`; hosts without that profile context leave this entry disabled. Headless, SDK and ACP bundles disable that entry in YAML; a later profile patch can enable it. Disabling or omitting HMR applies changes on restart. To enable source-module watching, configure the `hmr` entry supplied by the base bundle in the profile patch before launching:

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

Existing configurations replace the module name `@deepseek-ai/cordis-plugin-hmr` with `@deepseek-ai/dsh-hmr`. The `hmr` service key, `baseDir`, `config`, `getLinked()`, `getOuterStack()`, `hmr/change` and `hmr/reload` remain available. The vendored package remains available; DSH profiles use this package.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `base` | Context base URL | Base directory for module watching. |
| `root` | `["."]` | Module watch roots; `[]` retains only explicit configuration watches. |
| `ignored` | `["**/node_modules", "**/.*", "cache", "data"]` | Excluded module paths. |
| `debounce` | `100` | Milliseconds for combining module changes. |

Chokidar options, including polling, retain their existing meaning. Exact configuration watches also observe additions, removals and initially missing parent directories. They default to `awaitWriteFinish: true`: edits wait for Chokidar's 2-second write-stability window, avoiding its lossy change-event throttle. Configure `awaitWriteFinish` to adjust that window; disabling it can miss rapid consecutive edits. Direct Plugin Manager operations apply without waiting for file events.

Profile recompositions run by HMR's profile watches and by Plugin Manager also replace plugins whose loaded files below the profile directory changed on disk. This covers installed packages below `node_modules` and the targets of linked packages. A package whose files changed in place, such as a linked package whose build output changed or a dependency another installation upgraded, therefore takes effect without a restart at the next such recomposition; source watching through `root` is not required. A replacement that fails to load stops the previous plugin and is reported as `failed` with its load error instead of as a restart, which would load the same files; every later recomposition imports it again, so it starts once its files or dependencies are corrected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`watchConfig()` registers an awaited configuration handler and watches only its target path and required parent directories; sibling files, including temporary writer locks, are excluded before native watcher creation. `runExclusive()` serializes configuration changes and Loader updates with automatic reloads and rejects nested transactions. Package installation and removal run outside this queue. HMR does not acquire the package writer lock; manifest notifications reload only when the ordered `dsh.profile.bundles` list changes. Profile and home patch changes also trigger recomposition. File events received during a configuration transaction are processed afterward. Include refreshes and profile reconciliation reach plugins through ordinary Loader entry updates; Loader commits volatile-only changes in place.

App-boot owns profile parsing and patch precedence. HMR reads the launcher’s data-only `profileContext`, registers the profile manifest and both user patch watches during initialization, and waits for application readiness before processing changes. Its disposal closes the watchers and cancels reloads waiting for startup. Configuration watchers start outside the active transaction context so later notifications can enter the queue.

`reconcileProfile()` is shared by HMR’s profile watches and Plugin Manager; callers hold `runExclusive()`. Config Editor recomposes through app-boot without replacing modules. App-boot prepares and preflights the generation before caches or running entries change.

File comparison covers the profile directory and linked package targets, recorded when the application becomes ready. [ModuleFiles](src/module-files.ts) records inode, size and modification time; adding a hard link alone does not invalidate a module. Existing modules retain the identities read before replacement, preserving later writes. Newly loaded modules are recorded at settlement so a subsequent installation does not restart them merely because they are recent.

Replacement follows ES module links and every CommonJS parent’s `children`. A module's plugins are read from its ES module namespace and from the CommonJS exports Node already cached, without evaluating anything, so a CommonJS plugin registered outside a Loader entry keeps its cache. Host dependencies and plugins outside the traversable Loader tree stay pending. The remaining changed modules and their importers are evicted without a backup, and the Loader entries running affected plugins stop. HMR imports no replacement code itself: the Loader imports the current files when the generation starts an entry, so disabled, removed and incompatible rows never execute it, and dynamic `disabled` expressions and nested Includes are evaluated as at startup.

Affected runtimes stop without making their entries disabled, and `reconcileProfile()` passes them to app-boot's single `recomposeProfile()` call, which starts them, including those below an unchanged Include and those outside the profile composition, without importing an entry twice. A failure before any stop leaves every plugin running; stopped plugins start again with the current resolution when no generation applied. After eviction, a replacement that fails to import or start is an activation failure and rejects the operation; its previous code no longer runs. Every recomposition imports entries whose import failed again, after expiring the package configuration below the profile roots and evicting modules whose links failed, so a corrected file or a dependency installed later takes effect without a restart. [ProfileReconciliation](../../../docs/subsystems/boot.md#profile-reconciliation) lists changes requiring a restart. A module first loaded during a recomposition whose file was written after the comparison stays stale, so a write during activation is loaded next time; comparison or cache-inspection failure requires a restart even when no changed URL is known. HMR’s watches log the result.

After each recomposition, HMR evicts the loaded modules below the directories of the mappings the recomposition dropped and expires their package configuration, so the packages a removed or deselected bundle depends on, including those it imports dynamically, are imported afresh when it returns. A bundle package is not a mapping: its own files are replaced when they changed on disk, and a bundle switched off while its files stay unchanged keeps its modules loaded. A publication the runtime resolution rejects, such as a retained profile mapping that moved to another directory, stops and starts again the rows the generation would drop and leaves the composition as it was; the result has `restartReason: 'package-moved'`.

A changed `package.json` outside `node_modules` expires that package's cached configuration. A configuration-only manifest triggers no module reload; a manifest imported as a JSON module retains dependency-driven reloads, and one in the host dependency graph retains host reloads. Dedicated configuration watches keep their existing ownership. A new package entry takes effect when its Loader entry restarts.

Loader entries retain their raw import results. HMR retains every distinct imported namespace for each entry name and configuration-tree base URL; an uninitialized entry does not overwrite another entry's namespace. HMR matches those objects to cached ModuleJob namespaces instead of resolving entry names again. Names without an imported namespace and `cordis:` builtins keep name-based resolution. Source reloads therefore use the loaded modules after `exports` or `main` changes.

Entries sharing a runtime are replaced together, with each entry receiving the implementation for its own module. Duplicate entries for one module retain their separate plugin instances. On replacement failure, HMR removes partially activated replacements and restores the previous modules and plugin implementations. A successful reload updates every matching entry record, including disabled entries; a failed replacement leaves those records unchanged. Entries that have never loaded remain uninitialized.

[package-manifest.ts](src/package-manifest.ts) owns the Node internal interfaces for package reads, scope, type, and nearest-manifest lookups. Each HMR instance owns its configuration cache and restores its installed hooks on disposal. Manifest invalidation clears the ESM `ResolveCache` and CommonJS `_pathCache`: neither records every consulted manifest, and entries may point outside their package directory. CommonJS loads resolve requests with Node's default resolver before entering the native loader, bypassing old request aliases while preserving evaluated modules. Synchronous resolve hooks receive the resulting filenames. Ordinary module replacement remains HMR's separate operation.

Watched module paths use Node ESM resolution's `realpathSync()` spelling, including Windows short directory names, so file events match the module cache.

The module replacement implementation derives from `@cordisjs/plugin-hmr` 1.0.15, with Harness Node-loader and lazy-config changes. Its [MIT license](LICENSE) is retained.

</details>

<a id="model-experience"></a>
## Model Experience

### Reloaded plugins

#### What the model sees

`ctx.hmr` adds no model-facing tools or messages. Loaded plugins determine subsequent tool and prompt contributions.

#### Token effect

No direct token contribution.

#### KV Cache effect

Reloading a contributing plugin can change later request prefixes; HMR does not rewrite conversation history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Module replacement requires Node loader internals. Framework dependency changes call the host-provided `loader.exit()` hook; HMR itself does not restart the process.
- A change confined to `package.json` is not detected. Watcher notifications for manifests below `node_modules` are still ignored. The browser Client module graph retains its separate browser-side loading mechanism.
- Replacement follows static imports. A dynamic `import()` of a stale module evaluates the new file on its next call while its importer keeps running; existing Workers and the TSX loader thread keep their module caches.
- Every symbolic link below the profile's `node_modules` widens the comparison scope. Linking a package that the process entry point, located through the real path of a bin link, imports statically, such as `dsh-app-boot`, Cordis or the Loader from a dsh checkout, brings host modules into scope; their changes stay pending, and Plugin Manager reports `restart-required` for later operations until the process restarts. Linked dsh packages that Loader entries import are replaced like other plugins.
- The comparison records belong to one HMR instance. A recomposition that restarts the `hmr` entry itself records the current files again, so changes pending at that point are no longer reported or retried.
- A replacement that fails to import or start stays inactive until its files or dependencies are corrected; the previous version is not restored.
- Compatibility checks run only where DSH composes rows: startup, profile recomposition and preset mounting; the Loader checks nothing when it imports a module. A replaced profile row passes the recomposition's preflight, but a row outside the profile composition, such as a preset row or an entry added through `ctx.loader.create()`, restarts with replaced code without a check. Plugin Manager refuses incompatible versions, so this affects packages changed outside it, such as a manual `pnpm add` in the profile directory or a rebuilt `link:` package.
- The [packed worker loader](../../experimental/webworker-runtime/src/module-system/module-loader.ts) exposes neither Node’s `loadCache` nor `require.cache`; configuration recomposition remains available, but code replacement requires a restart. Native Node retains these caches even with asynchronous module hooks. The [packed worker browser test](../../../apps/web/tests/preview-boot.e2e.ts) exercises this deployment.
- A newly loaded file is first recorded after recomposition settles and counts as changed when its modification time follows the comparison. The comparison time is the modification time of a marker file HMR writes in the temporary directory, so on one machine both come from the clock local file writes are stamped with; an edit within the timestamp granularity of the profile's filesystem after the comparison counts as earlier and can be missed, and network filesystems stamp writes with the server's clock.
- A file replaced by a hard link to an older store file keeps an older modification time; when its module was first loaded after the last recording, the change is not detected.
- Profile recomposition caused by HMR's own watches does not run for dependency-only manifest changes, so an install performed outside Plugin Manager takes effect at the next recomposition or restart.
- TSX loaders and ordinary application-created Workers are outside the supported package-cache refresh scope.
- CommonJS requests must be resolvable by Node's default resolver. Synchronous hooks may postprocess the resulting filenames, as Desktop's Office resolver does; hooks requiring the original request name or introducing virtual requests are unsupported. Builtins retain Node's original loading behavior.
- Future work: retain package invalidation across HMR disposal and replacement. Restoring the native readers can expose their older cached configuration again.
- If a shared runtime's replacement modules have different plugin callbacks, an instance without a Loader entry cannot be assigned to one of them. HMR reports an ambiguity error and rolls back the reload.
- `watchConfig()` resolves when Chokidar reports readiness. On darwin, libuv starts the FSEvents stream afterwards on its own thread, so a write that lands within milliseconds of registration is not reported until the next event in that directory; edits made after startup are unaffected.

### Dev Note

<a id="dev-note"></a>

None.
