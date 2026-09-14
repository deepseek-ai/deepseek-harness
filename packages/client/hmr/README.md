---
description: "Development-only hot reload for browser client plugins: rebuilding a plugin bundle swaps the running plugin in place, for developers iterating on the web GUI."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-hmr

English | [中文](README.zh.md)

## Summary

`dsh-client-hmr` reloads a browser client plugin in place when its bundle is rebuilt, so a developer editing plugin source sees the change without a full page reload. The reload chain stays idle without a rebuild watcher: only a `pnpm run dev:web`-style process rewriting client bundles produces the rebuilds it reacts to. Each reload swaps one plugin with fresh component state while the data layer (connection, runtime, and Session objects) stays untouched. Everything here is development machinery in the browser; the model never sees it.

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

Enable the rebuild watcher for the plugin you are editing, then save: the browser picks up the rebuilt bundle from the dev server and swaps the plugin without reloading the page. Use it during client development; nothing observable happens in a production build, where no watcher rewrites bundles.

### Starting the reload chain

Run `pnpm run dev:web` (or any tsdown watch process that writes the plugin's `lib/client.js`) against the same host; rebuilt plugins are then swapped into the running browser automatically, one at a time.

### What a reload does

Each reload re-executes the plugin bundle and remounts the plugin with fresh state. Plugins that depend on the reloaded one reload with it automatically. A reload that fails is reported visibly and retried from scratch on the next rebuild.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `pollIntervalMs` | `500` | Bundle stat-poll interval in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-hmr) is the exhaustive source for every accepted field and its JSDoc.

### Observing success

A successful swap shows the edited UI immediately with no page reload, and the plugin keeps working after the swap. Remember the trade-off: React state inside the reloaded plugin is lost, while session, workspace, and connection state survives.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the reload chain is built; observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The chain is two halves with one contract: the node half owns bundle detection and notification, the browser half owns the swap. The node half runs one interval that stat-polls each graph bundle from the module host's pre-read baseline. An unchanged startup row starts watching without a content read or hash; a changed row, or a dirty row whose artifact reappears, enters `rebuilt()`, and only real revision changes are broadcast. `rebuilt()` reads the current source map together with the changed bundle; a map-only write does not reload executable code. The node half also serves `/plugins/events`, an SSE channel broadcasting `graph` and `rebuilt` frames.

### The browser swap

On a `rebuilt` frame the revision makes `invalidate` select that plugin's immutable one-resource combo URL instead of its initial multi-resource URL. `prefetch` loads and registers the new factory while the old fiber still serves. The remaining order is registry-first teardown (`registry.delete` before the fiber's disposer emits `internal/plugin`, or the vendored Loader flags the entry disabled), drain the old fiber's unload, delete `entry.fiber`, remove owned `<style data-plugin>` tags, then `entry.refresh()` re-imports and remounts, and `fiber.await()` rethrows startup failures loudly. The swap is safe because execution is pure registration under the lazy-CJS model: every module side effect lives in the factory closure and runs at materialization.

### Cascade and self-reload

A fiber's activation epoch strings its service providers' uids, so replacing a provider's fiber re-cascades every dependent through Cordis itself with zero HMR-side bookkeeping. This plugin is itself a graph entry, so a rebuilt frame may name it; the in-flight reload keeps running in the old bundle's closure and the new bundle's apply opens a fresh channel.

### Failure policy

No rollback: an import failure leaves the entry fiberless (the next rebuilt frame retries from scratch), and an apply failure leaves a FAILED fiber visible in the shell's status projection. Both log loudly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: bundle stat-poll, `rebuilt` reporting, `/plugins/events` SSE channel |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: SSE subscription, serialized reload queue, fiber swap |
| [`src/events.ts`](src/events.ts) | Shared frame types (`graph` / `rebuilt`) and the endpoint constant |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the reload contract is not enough: the module system that serves the bundles, the shell that boots them, and the module-graph rules behind the externals.

- [Client module system](../modules/README.md) — the lazy-CJS module table and `invalidate`/`prefetch` hooks this driver drives.
- [Web boot kernel](../web/README.md) — the shell that boots the plugin tree and shows entry status.
- [Client group map](../README.md) — the browser half this package reloads.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-hmr) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the reload driver is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the reload driver does not preserve or restore. They are current package constraints, not a task backlog.

- **Reload is coarse by design** — a fresh fiber and fresh components; React state inside the reloaded plugin is lost while the data layer (connection/runtime fibers, Session objects) is untouched. react-refresh-grade state preservation conflicts with re-executing the bundle and is deliberately out.
- **No failure rollback** — a reload that fails leaves the entry FAILED and visible in the loader status projection; the previous bundle is not restored automatically.
- **Rebuilt frames do not replace the boot graph** — each frame carries the plugin-artifact revision needed for its one-resource combo reload; a page reload receives the recomposed startup graph.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
