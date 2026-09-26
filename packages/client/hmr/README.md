---
description: "Live graph synchronization and development bundle reloads for Web client plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-hmr

English | [中文](README.zh.md)

## Summary

`dsh-client-hmr` keeps open Web pages in sync with the Host plugin graph and reloads rebuilt browser bundles. Ordinary plugin enable/disable changes take effect without reloading the page or restarting the Host. Code rebuilds replace the affected plugin with fresh component state. The model sees no new input or output.

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

The shipped Web composition mounts this transport for live plugin changes. During development, a bundle watcher also supplies code rebuilds. Disabling the transport stops graph delivery to open pages.

### Starting the reload chain

Run `pnpm run dev:web`, which starts the host and the rebuild watchers together (`--no-serve` attaches only the watchers to a host started elsewhere, as does any watch process using the shared Client tsdown preset); rebuilt plugins are then swapped into the running browser automatically, one at a time. The preset stamps `lib/client.js` after all package-local chunks are written, so a chunk-only rebuild also advances the package revision without Host-side chunk scanning.

### What a reload does

Each successful reload re-executes the plugin bundle and remounts the plugin with fresh state. Plugins that depend on the reloaded one reload with it automatically. Failures appear in the plugin list, where they can be retried without waiting for another rebuild.

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

The Host half watches each package's stamped entry artifact and serves `/plugins/events`. It forwards existing graph-change and rebuilt notifications; every new connection receives the current full graph. A graph describes the browser’s desired entries and carries no Host cleanup-completion guarantee. Host activation and cleanup remain owned by the Host lifecycle. The entry's mtime, ctime, and size identify the revision without hashing its contents; unchanged metadata requires no content read. Host restarts over unchanged artifacts keep the same revisions, so reconnecting the graph stream does not replace browser plugins. The browser half delegates both frame kinds to Client Modules, which serializes entry changes and waits for browser resource cleanup.

### The browser swap

On a `rebuilt` frame, the controller invalidates the old module and prefetches its single-resource script while the old fiber still serves. It then deletes the registry runtime, drains the old fiber, clears its entry reference and removes owned styles. The module system materializes the new exports before `entry.refresh()` mounts them through Loader; this exposes import failures to page diagnostics even when Loader would only log them. CSS is injected after old effects have finished.

### Cascade and self-reload

A fiber's activation epoch strings its service providers' uids, so replacing a provider's fiber re-cascades every dependent through Cordis itself with zero HMR-side bookkeeping. This plugin is itself a graph entry, so a rebuilt frame may name it; the in-flight reload keeps running in the old bundle's closure and the new bundle's apply opens a fresh channel.

### Failure policy

Download failures leave the running plugin active. After the old fiber is torn down, import or activation failure does not restore the previous bundle. Failures appear as page-local synchronization errors. Settings → Plugins → Plugin list retries the latest graph, even when its revision is unchanged; a later rebuild also retries the affected plugin. Successful unrelated plugins remain active.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: bundle stat-poll, `rebuilt` reporting, `/plugins/events` SSE channel |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: SSE subscription and delegation to the shared entry controller |
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
- **No failure rollback** — after the old fiber is torn down, a failed replacement does not restore the previous bundle.
- **Web transport only** — Electron installation and backend restart handling do not use this SSE path. Entry reconciliation itself is transport-independent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
