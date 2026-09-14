# @cordisjs/plugin-hmr

Hot module replacement for loader-managed Cordis plugins.

The HMR plugin watches source files, traces Node's module graph, clears affected
module caches, and reloads only the plugin entries that depend on changed
application files. Changes to framework-level dependencies fall back to
`loader.exit()`, letting the host process restart.

Module watches canonicalize their existing base directory before opening
Chokidar, so the native backend receives one filesystem spelling even when
Windows supplied an 8.3 alias.

## Requirements

- `@cordisjs/plugin-loader`
- `@cordisjs/plugin-timer`
- A runtime that exposes Node's internal module loader. The package throws if
  the loader service has no internal module loader available.

## Usage

```yaml
- id: timer
  name: '@cordisjs/plugin-timer'
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root:
      - src
    ignored:
      - '**/node_modules'
      - '**/.*'
    debounce: 100
```

## Config

| Field | Description |
| --- | --- |
| `base` | Optional base directory resolved from `ctx.baseUrl`. |
| `root` | Chokidar roots to watch. Defaults to `['.']`. |
| `ignored` | Picomatch patterns excluded from watch and reload analysis. |
| `debounce` | Milliseconds to wait before processing a burst of changes. |

## Events

| Event | Description |
| --- | --- |
| `hmr/change` | Emitted for changed files that are not handled by plugin reload or config reload. |
| `hmr/reload` | Emitted after one or more plugin entries are reloaded. |
