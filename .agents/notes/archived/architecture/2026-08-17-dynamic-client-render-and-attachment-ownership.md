# Agent Note: Dynamic client render and attachment ownership

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-17-dynamic-client-render-and-attachment-ownership.zh.md)

## Problem

The host-authored client graph governs browser plugins, but three presentation paths sat outside that lifecycle. The web kernel created the React root and a shell-owned assembly pseudo-entry, `ui-conversation` imported attachment components as package values, and the shell imported ui-theme's global styles. Disabling, failing, or reloading a plugin therefore did not govern all of the rendering and CSS that belonged to it.

The loading and failure page has the opposite requirement: it must remain usable when any dynamic plugin, including the renderer, fails to activate. It cannot depend on the React tree whose failure it reports.

## Decision

`@deepseek-ai/dsh-client-web` is a framework-free boot kernel. It draws its loading and failure page with DOM operations and local CSS fallbacks, constructs the client module system and Cordis Loader, creates the statically adopted modules bootstrap entry plus every host-graph entry, and waits until every fiber is ACTIVE. Loader state changes retain one spinner node and update only its CSS arc when an entry first becomes active. The arc grows from one fifth to four fifths of the ring, preserving a visible gap throughout rotation. After the roster settles, the kernel resolves `ctx.uiRenderer` and hands the existing container to `mount()`.

`@deepseek-ai/dsh-client-ui-renderer` is an `immediately` dynamic client plugin. It owns the React slot outlets, SessionProvider, and observable-to-uSES binding. After its `slots` and `sessions` injections activate, it installs the slot renderer and provides `ctx.uiRenderer`. `mount()` hydrates the kernel-authored boot DOM, then replaces it with the assembled application in a layout effect before the browser can paint an intermediate frame. The hydrated spinner node retains its animation phase. The assembled tree projects the selected session title and performs the sole context-level `renderSlot('root')` call. The service, renderer installation, and React root all dispose with their owners.

`ui-conversation` declares `conversation.input.attachments` and `conversation.message.images` and supplies attachment data, callbacks, authorized image loading, and its locale seat. `ui-attachment` waits on those declarations through `ctx.slots.inject()` and registers the draft rail/drop target and historical image gallery/lightbox. The React implementations remain internal package values; cross-plugin composition uses slots. This package integration supersedes the direct-import ruling in the [attachment display note](../feature/2026-08-11-web-attachment-display-alignment.md) without changing that note's visual and interaction decisions.

ui-theme imports its five global stylesheets as `?inline` strings. Its client entry calls `installThemeStyles(ctx)`, which installs one style tag per sheet through `ctx.effect()`, so unloading or reloading ui-theme removes or replaces its global CSS with the same lifecycle as its service. The web kernel retains only mount defaults and a self-contained boot-page palette whose fonts and colors match the corresponding theme tokens.

React, React DOM, Cordis, ui-slots, and ui-primitives remain static platform modules with one browser identity. The dynamic ui-renderer bundle consumes those shared modules and owns the rendering effects.

## Verification

Component tests pin the persistent progress spinner, hydration without boot-DOM mutation, document title, application tree, attachment entries, and disposal. The assembled built-bundle boot exercises the real module table and dynamic entries, while the theme style tests prove its tags install and dispose with the plugin fiber. The browser replay lane covers the complete handoff from the framework-free page to the rendered application.

## Alternatives considered

**Keep the shell-owned app assembly pseudo-entry.** Rejected because it remains invisible to the host graph and makes render ownership a special Loader path even though the assembly has ordinary service dependencies and lifecycle effects.

**Keep exported attachment atoms and import them from ui-conversation.** Rejected because a direct component import bypasses independent plugin composition and reload ownership. Owner data still travels directly through typed slot props; only presentation selection is dynamic.

**Keep ui-theme styles in the shell's base stylesheet.** Rejected because theme CSS would remain active when the theme plugin is absent or failed and would not participate in plugin reload cleanup.

**Render the failure page with React.** Rejected because a ui-renderer or React-tree failure must not remove the only diagnostic available in the browser.

## Consequences

The host graph contains every dynamic rendering owner, and HMR replaces attachment presentation, render assembly, and theme CSS through plugin lifecycle. A ui-renderer failure leaves a readable DOM failure page instead of a blank React mount. Omitting ui-attachment deliberately leaves its optional slots empty; the shipped web composition includes it, and a configured entry that fails activation prevents the full-application handoff.

The application still waits for the complete client roster before its first React frame. The shell still statically bundles the platform module identities, and the boot page maintains a small private light/dark palette because ui-theme CSS is unavailable until that plugin materializes.
