---
description: "Browser UI renderer: React bindings for ordinary Slots and reusable Component Factories, ctx.uiRenderer, and the assembled dsh web application root."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-renderer

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-renderer` mounts the assembled dsh web client GUI: after the complete client plugin roster settles, the boot kernel calls `ctx.uiRenderer.mount(container)`, which hydrates the framework-free boot page and switches to the full React application before the next paint. Business plugins stay plain React components that receive session and workspace data through typed props and never wire subscriptions themselves — the renderer binds the runtime's bare observable sources into selector hooks at the slot outlets. The web shell and the boot kernel are its only direct consumers, so a composition needs it exactly when it wants a React-rendered GUI.

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

This package is infrastructure: the web shell and the boot kernel are its only direct consumers. A composition needs it whenever it wants a React-rendered GUI — `dsh-client-web` loads the roster, waits for it to settle and for the boot audit to accept it, then calls `ctx.uiRenderer.mount(container)`.

### What mounting does

`mount(container)` synchronously installs styles for already materialized modules, hydrates existing boot DOM when present, and renders the application. Its disposer unmounts React before releasing styles. One renderer instance owns one active mount; a second simultaneous mount rejects, while an old disposer cannot remove a later mount. Plugin disposal also releases the active mount. The renderer performs the sole context-level `renderSlot('root')` call; the root occupant owns product layout.

### For business plugins

A mounted Slot receives `useDocumentPortal()` and `useDocumentViewport()` without injecting another service. `const Portal = useDocumentPortal()` returns a stable component: `<Portal onKeyDownCapture={onKey}>{children}</Portal>` renders into the application document's body and retains the nearest `data-plugin` marker at the source. The content sits in a `body > [data-document-portal]` wrapper without a layout box, so shell rules for body-level layers, such as the macOS window-drag subtraction, apply to the wrapper's children. Children mount in the commit that renders the portal, already in the body under the source's marker, so their layout effects and the caller's effects can measure and focus them; render `<Portal>` together with the content it shows. `onKeyDownCapture` and `onKeyDown` receive native document events even when focus is outside the portal; unmounting removes the listeners. The viewport hook returns `{ width, height }` in CSS pixels, excluding scrollbars, and updates on resize. Neither hook depends on the plugin's execution window.

A business plugin registers an ordinary Slot entry or a reusable Component Factory; the renderer binds the runtime's session and workspace observable sources into selector hooks at the render position. The plugin receives standard scope props through its derived Component props — it never imports the renderer or touches React internals. Every renderer-created Component can render a Factory occurrence, and a Factory can expose caller-selected local Components without sharing implementation values between packages.

<a id="package-style-isolation"></a>
### Scope one package's styles

Client stylesheets are global by default. To limit a built-in or external plugin's own selectors to its content, set `__unstable_enable_client_isolation: style` on its [Loader entry](../modules/README.md#script-isolated-packages) in `cordis.yml`. A loaded package adopts a changed style setting when it reloads; reloading the page also applies the published setting. `scriptandstyle` also selects script isolation; `script` alone leaves CSS global. Dependency stylesheets keep their own settings, and an unscoped theme can still reach the plugin.

Inspect the [slot roots](../../../docs/subsystems/slots.md#slot-style-ownership) for `data-plugin`, the supplying package. To see whether a stylesheet is scoped, inspect its `<style data-plugin="…" data-path="…">` in the document head for an `@scope` rule. The renderer marks each winning [list item](../../../docs/subsystems/slots.md#list-item-roots) and the place where a [hoc layer forwards children](../../../docs/subsystems/slots.md#hoc-layers); components need no wrapper or extra props. If a selected package depends on an ancestor outside its root, use an inherited theme token or put the relevant state on its own content.

If a selected stylesheet is missing, check the browser console for its package and path. The browser must parse the sheet inside one native `@scope` rule. Compile out top-level `@import` and `@namespace` before enabling isolation. A failure omits the affected sheet rather than installing it globally.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package realizes one boundary: the object layer (runtime, React-free) owns business state; this renderer is the only place ctx-to-React integration happens — slot renderer, `SessionProvider`, and the `useSyncExternalStore` adapter.

### Activation and mount

The plugin injects `modules`, installs the Slot renderer, and publishes [`UiRenderer`](src/client/renderer.ts). On `mount()`, [`DocumentStyles`](src/client/styles/document-styles.ts) installs CSS before React mounts and subscribes to module records. Materialization, dependency changes, and invalidation update installed resources synchronously. The installer wraps the text from `record.meta().stylesheets` in native `@scope` only when `record.isolation.style` is true. A replacement record supplies fresh metadata, text and flags.

Each installed `<style>` carries `data-plugin` (package) and `data-path` (that stylesheet's key in `meta().stylesheets`). Loaded dependencies precede consumers. A package and path share one style node; conflicting CSS keeps the installed text. If `meta()` fails, that record supplies no sheets; if `text(context)` fails, only that sheet is missing. The renderer reports the failure once through `console.error` and installs the remaining styles. Failed producers run again only for a replacement record. During live replacement, previous styles remain until the old plugin is torn down; component mounts do not own them.

### Slot bindings

`createSlotRenderer` connects the slot registry to React: ordinary entry lists and Factory definitions become reactive sources, and each outlet or occurrence renders through the installed renderer. Business plugins pass bare observable sources through typed `hooks`; the renderer binds them at the render position via the uSES adapter. A Factory Store factory stays lazy until an occurrence first materializes; its exclusive handle rejects persistence, render-time records stay weak, and an idempotent effect strongly retains only mounted occurrences while preserving identity across effect replay. Factory errors use the ordinary supervision channel without abdicating the shared definition: the definition and its fallback local Components report against the definition, caller-selected local Components report against the caller registration, and each boundary resets with its own scope incarnation.

### Identity

React, React DOM, and Cordis retain one browser identity through the web shell's static module table, and ui-slots and ui-primitives through their `immediately` rows; this package arrives as a dynamic client bundle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the surrounding machinery and the composition model.

- [ui-slots](../ui-slots/README.md) — the slot registry pure core this renderer binds to React.
- [web](../web/README.md) — the shell that loads the roster and calls `mount`.
- [ui-session](../ui-session/README.md) — the adapter that supplies the standard Session sources and hooks this renderer binds.
- [Web client architecture](../../../docs/subsystems/web-client.md) — the loading chain, object layer, and layering red lines.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive composition model.
- [Component Factories](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md) — reusable definitions, local Component selection, and occurrence lifetimes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side render assembly that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the application frame appears and how far per-region readiness goes; they are current package constraints.

- **The first application frame waits for the whole client roster** — the boot kernel hands over the mount point only after the loader roster settles and the boot audit accepts it; per-region readiness remains deferred.
- **Styles target the main document.** Native `@scope` limits selector matches, not inherited values. React's `createPortal` and arbitrary JSX moved through props do not automatically carry the source package's scope; `useDocumentPortal()` retains the source marker. There is no separate presentation document or Shadow DOM; styles follow module, not component, lifetimes.
- **Slot rendering has no Suspense integration or per-entry lazy loading** — the complete plugin roster settles before the renderer mounts the root.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
