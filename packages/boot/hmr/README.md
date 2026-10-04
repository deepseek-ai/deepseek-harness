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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`watchConfig()` registers an awaited configuration handler. `runExclusive()` serializes configuration changes and Loader updates with automatic reloads and rejects nested transactions. Package installation and removal run outside this queue. HMR does not acquire the package writer lock; manifest notifications reload only when the ordered `dsh.profile.bundles` list changes. Profile and home patch changes also trigger recomposition. File events received during a configuration transaction are processed afterward. Include refreshes and profile reconciliation reach plugins through ordinary Loader entry updates; Loader commits volatile-only changes in place.

App-boot owns profile parsing and patch precedence. HMR reads the launcher’s data-only `profileContext`, registers the profile manifest and both user patch watches during initialization, and waits for application readiness before processing changes. Its disposal closes the watchers and cancels reloads waiting for startup. Configuration watchers start outside the active transaction context so later notifications can enter the queue.

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
- Replacing installed package versions still requires a restart through Plugin Manager; manifests below `node_modules` keep Node's cached configuration. The browser Client module graph retains its separate browser-side loading mechanism.
- TSX loaders and ordinary application-created Workers are outside the supported package-cache refresh scope.
- CommonJS requests must be resolvable by Node's default resolver. Synchronous hooks may postprocess the resulting filenames, as Desktop's Office resolver does; hooks requiring the original request name or introducing virtual requests are unsupported. Builtins retain Node's original loading behavior.
- Future work: retain package invalidation across HMR disposal and replacement. Restoring the native readers can expose their older cached configuration again.
- If a shared runtime's replacement modules have different plugin callbacks, an instance without a Loader entry cannot be assigned to one of them. HMR reports an ambiguity error and rolls back the reload.
- `watchConfig()` resolves when Chokidar reports readiness. On darwin, libuv starts the FSEvents stream afterwards on its own thread, so a write that lands within milliseconds of registration is not reported until the next event in that directory; edits made after startup are unaffected.

### Dev Note

<a id="dev-note"></a>

None.
