---
description: "Web boot kernel for the web GUI: two-stage boot of the client plugin tree, the framework-free boot page, and the shared module table, for users and maintainers composing or debugging the browser application."
kind: "package-library"
---

# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

## Summary

`dsh-client-web` boots the web GUI: it loads the client module system from the Host-provided boot graph, then activates the client plugins before the application mounts. The UI mounts once every required plugin and every plugin a required one waits on is up; any other plugin that fails is reported in the console and left out. A framework-free boot page keeps a required-plugin failure visible instead of a blank screen. It also defines the shared module table (`PLATFORM_MODULES`) that every dynamic bundle resolves its externals against. The model never sees this package.

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

Use it when you assemble the browser application: `apps/web`'s Vite entry runs `new AppWebEntry(container).run()` against the mount point, and the boot page carries the user through activation. Ordinary browser callers pass no options. A pre-injected page transport is the default ahead of the `seams` override: when `globalThis.__DSH_TRANSPORT__` carries `loadBundle`, the module stage adopts it as the bundle transport and skips the immediate-tier HTTP prefetch; when it carries `resolveAsset`, the module stage adopts it as the resolver that maps each `require.asset` package-asset reference to a URL the page can load; while explicit `seams` still win (for example jsdom tests, where external `<script>` execution cannot reach the page context).

Static application pages install `__DSH_BOOT_READY__` before the entry runs. The boot page renders immediately while `run()` waits; the page owner applies the Host rows with `applyIndexInjections` (also exported from `./injections`) and resolves the deferred after all scripts finish. A rejected deferred renders a boot failure unless the caller supplies `run(onFailure)` to present the error externally while retaining the loading page. Desktop uses this callback to request native recovery. Desktop and WebWorker share the injection interpreter; server-side `tapIndex` HTML transforms apply only to served documents.

The shell base styles apply automatic CJK/Latin spacing to ordinary content in supporting browsers. Semantic code and terminal, diff, read, and search output containers retain literal source spacing and column alignment; browsers without `text-autospace` support ignore both declarations.

Web and Desktop mathematical rendering requires WOFF2 support. The [Web build](../../../apps/web/katex-fonts.ts) retains every KaTeX font face in WOFF2 and omits WOFF/TTF fallbacks; a face without WOFF2 rejects the build. Font glyphs, weights, styles, and layout rules are preserved.

### What boot looks like

Boot runs in two stages: the module stage adopts the parser-loaded bootstrap batch, builds the module system from the Host-provided boot graph, and prefetches the `immediately` tier through the shared application-batch URL, which executes once. The plugin stage then activates every graph entry and waits for all of them before handing the marked boot DOM to the UI renderer, which hydrates it and switches to the complete UI.

### The boot page

The boot page uses plain DOM and local CSS, so bundle and plugin-activation failures remain visible: it shows one spinner node whose CSS arc grows as entries activate. The spinner and its animation phase persist until the full UI replaces the boot page. When a required plugin fails import or activation, the page names every inactive plugin with the reason (missing service, import failure, or activation error) and marks the required ones, instead of a blank page. An optional plugin's failure appears in one console warning and does not stop the application. The console contains the original import error.

<a id="the-shared-module-table"></a>
### The shared module table

`PLATFORM_MODULES` (in `src/platform.ts`) names the shell-seeded shared modules — React, Cordis, Zod (`zod`), TanStack Virtual (`@tanstack/react-virtual`), and static UI libraries — and together with `PRELOADED_CLIENT_EXTERNALS` (the parser-preloaded runtime row) defines the implicit external baseline every dynamic bundle resolves against. `dsh.client.external` adds only exact non-baseline requests; see [shared modules and the module graph](../AGENTS.md#shared-modules-and-the-module-graph).

Built-in and installed browser plugins in the same page receive the same module instances. The shell supplies the dependency versions declared in this package's `package.json`; the module table does not negotiate versions per plugin. External plugins that use these modules must target a host that provides the required specifiers and APIs, and keep those imports external when building their client bundle. Inlined dependencies remain private to their bundle; Host code and Workers resolve their dependencies separately.

### Configuration

The package accepts no plugin config of its own; the generated [configuration catalog](../../../docs/config-catalog.md) lists every plugin config in the repo for comparison.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Menus use the shared `MenuSurface` material, including the macOS backing for background blur; custom content follows the [menu rules](../../../docs/web-styling.md#component-rules).

On macOS, native window regions use full element boxes without overflow clipping. The shell resets inherited regions and limits automatic control exclusions to `data-window-drag` rows or explicit `data-window-drag-controls` scopes. Scrollable content outside those scopes receives no automatic exclusion. An interactive viewport without nested drag rows uses `data-window-drag-exclude` to exclude only its own box; covering overlays and containers with their own drag rows declare their regions separately. Body portals need a real box, or an explicit exclusion on their visible content.

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the boot kernel is built; observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The kernel owns exactly three things: the module system, the Cordis Loader, and the boot page. The Host owns the graph, batch preload, and loader facade, so `AppWebEntry` never knows the bootstrap package id or parses the wire format. The dynamic UI renderer receives the mount point only after the activation audit accepts the client tree.

### Two-stage boot

`run()` calls the Host-installed `window.__ModuleLoader__.create({ boot, staticModules, ...seams })`; the facade returns the constructed module system and parsed manifest after adopting the parser-loaded bootstrap batch. The module stage prefetches the `immediately` tier through the one shared application-batch URL. The plugin stage mounts the Loader, assigns `loader.internal = modules`, creates every graph entry uniformly, awaits quiescence, then audits activation with the same policy as [Host startup strictness](../../../.agents/notes/implemented/architecture/2026-09-09-consumer-owned-startup-strictness.md): an entry that failed import, stayed pending on a missing service, or landed in another non-active state is inactive. When an inactive entry is on the global required list in [`src/boot-client.ts`](src/boot-client.ts) (the module system, Session control, renderer, application frame, Session view, and sidebar), the audit throws one aggregated error naming every inactive entry and marking the required ones; otherwise it writes one console warning and the application mounts. A required name absent from the graph has no effect. An entry that a required entry waits on leaves the required entry pending, so its failure also rejects startup. An entry the Loader could not create, because its module failed to import or exports no plugin, has no fiber and is reported as an import failure, as the Host audit reports `failed to import`; the original error is in the console log.

### Boot page mechanics

The boot page is plain DOM with local CSS whose fallback fonts and colors match the theme tokens that arrive during loading. `internal/status` events drive one spinner node; a failed entry is not drawn before the audit, because it may be optional. Hydration preserves the node and animation phase through the application commit, and `fail()` renders the thrown reason. React mounting, slot rendering, and assembly live in `ui-renderer`; `ui-layout` owns the assembled browser-title projection.

The boot kernel delegates manifest entry creation to Client Modules so live graph synchronization owns the same entry identities after startup. The initial activation audit rejects only required entries; later page-local failures appear in Settings → Plugins → Plugin list.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Library entry: `AppWebEntry`, `getStaticModules`, platform tables |
| [`src/boot.ts`](src/boot.ts) | `AppWebEntry`: module stage, boot page, immediate-tier prefetch, window drag-rect watcher install, then `bootClient` + `mountClient` |
| [`src/boot-client.ts`](src/boot-client.ts) | `bootClient` / `assertEntriesActive`: Loader mount, one entry per manifest row, activation audit |
| [`src/mount.ts`](src/mount.ts) | `mountClient`: renderer handoff through a `uiRenderer` dependency fiber |
| [`src/boot-page.ts`](src/boot-page.ts) | Framework-free boot page: spinner, per-entry status, failure rendering |
| [`src/platform.ts`](src/platform.ts) | `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS`: the implicit external baseline |
| [`src/seed.ts`](src/seed.ts) | Static module table handed to the loader at boot |
| [`src/window-drag/regions.ts`](src/window-drag/regions.ts) | The darwin app-region composition model, and the interactive selector `base.css` subtracts |
| [`src/base.css`](src/base.css) | Page defaults and native drag regions; inert subtrees neither add nor subtract drag rectangles |
| [`src/window-drag/recall.ts`](src/window-drag/recall.ts) | The shell's one window drag-rect watcher (electron/electron#32341): measure the marked rows per frame and pulse the recall mark while they move |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the boot contract is not enough: the module system it boots, the renderer that mounts the app, and the client authoring rules behind the baseline.

- [Client module system](../modules/README.md) — the lazy module table and boot graph this kernel consumes.
- [UI renderer](../ui-renderer/README.md) — receives the mount point and binds slot data to React.
- [Client modules subsystem](../../../docs/subsystems/client-modules.md) — the web plugin table, boot graph wire, and bundle route.
- [Client authoring rules](../AGENTS.md#shared-modules-and-the-module-graph) — the shared-module baseline and `dsh.client.external` semantics.
- [Client group map](../README.md) — the browser half this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as the boot kernel is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the boot kernel does not support. They are current package constraints, not a task backlog.

- **Optional boot failures start console-only** — an optional plugin that fails during the initial boot, including one whose creation the Loader rejects, appears in the console warning; Settings → Plugins → Plugin list lists it only after a later graph synchronization reconciles it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
