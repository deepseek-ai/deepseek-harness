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

App-boot owns profile parsing and patch precedence. HMR reads the launcher’s data-only `profileContext`, registers the profile manifest and both user patch watches during initialization, and waits for application readiness before processing changes. Its disposal closes the watchers and cancels reloads waiting for startup. HMR also owns module-cache replacement and reload scheduling. Configuration watchers start outside the active transaction context so later notifications can enter the queue. No invariant companion is published because the queue and watcher registrations have no independent persisted projection.

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
- Replacing installed package versions still requires a restart through Plugin Manager. The browser Client module graph retains its separate browser-side loading mechanism.

### Dev Note

<a id="dev-note"></a>

None.
