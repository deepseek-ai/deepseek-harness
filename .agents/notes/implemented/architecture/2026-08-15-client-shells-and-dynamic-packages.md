# Agent Note: Client shell layering and dynamic package boundaries

Status: implemented

English | [中文](2026-08-15-client-shells-and-dynamic-packages.zh.md)

> The [client plugin loading model](2026-07-23-client-plugin-loading-model.md) owns module arrival, Cordis lifecycle, and HMR. This note owns package placement, build faces, shared module requests, and npm dependency declarations; those decisions supersede the older package taxonomy and import-edge rules in the loading note.

## Problem

Client npm dependency sections describe installation and development relationships, but they do not reliably describe bundle contents. Treating `dependencies`, `peerDependencies`, or `devDependencies` as implicit bundler instructions can inline a shared React or workspace identity, or leave a built library carrying unresolved child imports without the host that is meant to assemble them.

The browser application also contains distinct roles: the HTML/Vite compilation entry, the framework-free Cordis startup kernel, static assembly libraries, and Loader-governed plugins. Early execution from HTML is an arrival policy, not a package kind. Modules must arrive before the Vite main module while retaining its ordinary `lib/client.js` artifact and dynamic graph row.

Shared UI libraries still expose synchronous TypeScript and React values to many consumers. Until those values move behind services or slots, making the libraries formal dynamic entries would preserve the value coupling while obscuring which module identity the shell must share.

## Decision

### Layers and build forms

| Layer | Members | Responsibility | Build and load form |
| --- | --- | --- | --- |
| Web compilation shell | `apps/web` | Owns `index.html`, Vite configuration, dist chunks, and static assets | Assembles final browser output from built package exports |
| Startup kernel | `packages/client/web` | Owns the plain-DOM boot page, module-system wiring, Cordis settlement, and renderer handoff | `staticLinked` `lib/index.js`; no `dsh.client` row |
| Static assembly libraries | Cordis, `ui-primitives`, `ui-slots` | Supply shared module identities and direct value APIs | ESM `lib/index.js`, merged and chunked by Vite; not Loader entries |
| Module bootstrap | `packages/client/modules` | Supplies the client module table and its Cordis wrapper | Dynamic package with one ordinary `lib/client.js`; the host delivers its factory early |
| Dynamic client packages | connection, `ui-renderer`, theme, and feature plugins | Participate through Cordis services, slots, and effects | Declare `dsh.client`, emit self-registering `lib/client.js`, and remain host-graph entries |

`packages/client/web` keeps Cordis as matching peer and development dependencies and uses modules and static UI packages as development compilation inputs. `apps/web` consumes built package exports rather than aliases into workspace source.

The `staticLinked` preset leaves every bare specifier as an external import in `lib/index.js` and emits relative CSS assets beside it. The Vite host resolves and deduplicates those imports and decides final chunk boundaries. A static library therefore does not copy the host's bundling policy into its own artifact.

### Shared module requests

Dynamic browser bundles implicitly externalize the common baseline: `PLATFORM_MODULES` names shell-seeded React, Cordis, and static UI identities, while `PRELOADED_CLIENT_EXTERNALS` is reserved for a dynamic identity that must arrive before shell boot and is currently empty. A package uses `dsh.client.external` only for an exact non-baseline value request. Type-only imports are erased and create no request; permitted third-party implementation libraries remain private bundle contents.

A request has exactly two suppliers:

1. The dynamic package row it names; a trailing `/client` aliases that package row.
2. An exact key in the shell's static module table.

There is no general `dsh.client.provide` alias mechanism. Dynamic rows and static keys exhaust the real suppliers, while Cordis service provision remains independent. Graph composition rejects malformed or missing requests, self-requests, and synchronous request cycles, and orders dynamic suppliers before their consumers. `ClientModuleSystem.import()` and `prefetch()` recursively register those dynamic supplier factories before the consumer can materialize, so network timing cannot violate the synchronous request graph.

### Parser preloading and React handoff

The modules Node half injects the startup protocol into the served HTML in this order:

1. Install `window.__ModuleLoader__` in queue mode with `pendingQueue`, `load()`, and `create()`.
2. Start preloading every revisioned application combo URL containing the rows other than modules.
3. Execute every blocking bootstrap combo URL; these currently contain the ordinary modules factory registration.
4. Assign `window.__DSH_BOOT__`, including all scheduling descriptors and every row's one-resource HMR combo URL.
5. Execute the Vite main module.

The bootstrap combo currently registers only the modules factory. The startup kernel passes the raw graph and shell seeds to `__ModuleLoader__.create()`. The facade removes the modules registration, materializes it with a `require` function that rejects every external, and invokes its `createClientModuleSystem` export. The modules bundle parses the graph, constructs and returns `ClientModuleSystem`, caches its own exports as the modules row, and switches the same facade to live mode. The kernel installs that instance as its Loader's `internal`, and the modules plugin reads it there when it provides `ctx.modules`. The modules client face consequently has a zero-external bootstrap requirement and no module-global system identity.

The Host publishes graph and combo descriptors without concatenating response bodies. Each script URL shares one lazy Promise that concatenates its captured bundle bytes on first `GET` and appends the corresponding map URL; each map URL has a separate lazy Promise that reads and composes source maps only on its first `GET`. `HEAD` requests trigger neither body. The Web URL remains gated by Loader settlement and the required-entry audit, but that readiness point does not materialize combo bodies; an index request reads the current graph.

The theme Host contribution is prepended to index collection. CSS in the head selects the initial document canvas palette, using `prefers-color-scheme` directly for the `system` preference; a body script applies the existing palette attribute and font-size variable before the loading page and application module.

After the `immediately` tier has registered its factories, the kernel creates all Loader entries, awaits Cordis quiescence, and requires every fiber to be ACTIVE. It then calls `ctx.uiRenderer.mount(container)`. The dynamic `ui-renderer` package owns React, slot rendering, hydration of the existing boot DOM, and the React root lifecycle; the startup kernel and failure page remain React-free.

### Dependency declarations

Every Client package keeps Cordis in matching `peerDependencies` and `devDependencies`; Cordis is its only peer. Browser imports, type references, module augmentations, and `dsh.client.inject` are development inputs because the Client build and shipped profile supply their runtime identities. A package that also publishes a Host entry keeps that entry's runtime value imports in `dependencies`. [Published dependency faces](../process/2026-08-26-published-dependency-faces.md) owns package discovery, exceptions, and the explicit Host roster.

Ordinary installed libraries remain `dependencies`: a dynamic build may bundle a private implementation, while a `staticLinked` library retains its bare import for the final host. Each build face decides externality independently from npm sections. Published file lists cover every runtime entry, relative asset, and declaration file reached by the artifact.

`verify-package-dependencies` enforces and repairs dependency sections. `verify-client-packages` enforces build forms, parser-preload alignment, shared-module requests, and module-graph acyclicity. The repository publint pass enforces publication closure.

## Alternatives considered

**Convert every client package into a dynamic plugin immediately.** `ui-primitives` and `ui-slots` still provide synchronous values without independent service or slot lifecycles; a manifest declaration alone would not remove those imports.

**Generate a separate `client-static.js` for modules.** The package remains a dynamic graph row and Cordis plugin; only its factory arrival is early. A second artifact would encode host policy in a filename and create two runtime products from one source.

**Compile all shared modules into the Vite entry.** This would remove deployment composition and plugin-level replacement from business plugins, including the renderer and theme.

**Retain a general module-provider declaration.** Package rows and exact static keys already name all suppliers; aliases would add another ownership protocol without a third supply source.

**Hardcode preload URLs in `apps/web/index.html`.** URLs and `rev` values belong to the host's current graph. Rewriting the served HTML keeps the queue, bundle URLs, and manifest on one graph revision.

## Consequences

Bundle contents stay stable when an internal DSH relationship is development-only, because each build face declares externality directly. Static libraries remain host-assembled, while dynamic packages retain uniform artifacts and lifecycle governance. The shipped profile owns the complete Client package roster, so individual Client packages do not ask npm to solve the same graph again through peer placement.

The startup protocol depends on the modules package id, and modules must remain self-contained at runtime. Combo generation preserves its ordinary package artifact and gives every other row one shared initial transport; HMR uses the same route with that row as its sole resource. Deferring response bodies moves concatenation to first access, while separately deferring maps keeps debugger-only work off script delivery. A missing bootstrap registration fails before Cordis starts; later plugin import, apply, and service-wait failures remain visible through the boot page's ACTIVE scan.

The shell consumes built `lib/` products, so source and browser artifacts can drift until the relevant build or watcher runs. Typechecking source alone does not prove the served application uses the same code.

The two static UI libraries remain deliberate exceptions. Converting either one to a dynamic package requires moving all value consumers to services or slots and removing its identity from the static seed in the same change.
