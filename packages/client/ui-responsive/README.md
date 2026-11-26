---
description: "Read CSS media-query answers and the mobile-device class in Web Client Slot components through the useMediaQuery and useMobile standard props."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-responsive

English | [中文](README.zh.md)

## Summary

Let any Web Client Slot component switch structure or behavior on a CSS media query, or on whether the page runs on a phone or tablet, without reading `window` itself. `useMediaQuery(query)` answers whether a query matches the page window now and rerenders the component when the answer changes. `useMobile()` answers once per page for automatic focus and soft-keyboard decisions. Style-only differences stay in CSS `@media` rules.

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

The Web application bundle mounts this Client plugin without configuration fields. It publishes two global standard props, so every Slot component receives them in every scope.

### Choose a prop or CSS

- `useMediaQuery(query)` returns whether the CSS media query matches in the page window, and the component rerenders when the answer changes. Use it when the answer selects rendered structure or behavior, such as skipping an entrance under `(prefers-reduced-motion: reduce)`. Keep a style-only difference in a CSS `@media` rule.
- `useMobile()` returns the `isMobileDevice()` answer of [ui-primitives](../ui-primitives/README.md): phones and tablets recognized from the user agent, including an iPad in desktop mode. The answer stays fixed for the page lifetime. Use it only for behavior such as automatic focus and the soft keyboard; layouts select their breaks with width media queries, as the [responsive rules](../../../.agents/skills/dsh-responsive-ui/SKILL.md#9-input-capabilities-and-mobile-text-fields) require.

### Compose and test

Plugins whose components read these props, among them the composer and the Session panel, inject the `uiResponsive` service that this package provides, so each starts only after both props are published and unloads with them; a plugin whose components read either prop does the same. The service has no public members. A custom Web roster keeps this package whenever it keeps such a plugin; without it, those plugins wait for `uiResponsive` and do not start. A component test that builds props by hand spreads `responsiveHooks(options?)` from the [client test runtime](../../test-support/client-runtime/README.md), whose `SlotTestRuntime` provides a `uiResponsive` stand-in with those defaults.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `uiResponsive` service contributes one root standard-source entry through `ctx.slots.provideRoot` when it is constructed. Its keyed `mediaQuery` resolver keeps one observable source per query string for the service lifetime, so components that read the same query share the `MediaQueryList` that `window.matchMedia` returned. Each subscriber adds its own `change` listener and removes it when it unmounts. The renderer binds the resolver to `useMediaQuery`; this package contains no React code. `useMobile` is a plain function prop over the `isMobileDevice()` answer read at construction. Disposing the service fiber withdraws both props and the service, which unloads the plugins that inject it.

| File | Owns |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | The `uiResponsive` service, the per-query sources, and the `GlobalStandardProps` declarations |
| [`src/index.ts`](src/index.ts) | The empty Host Loader entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web Client Slots](../../../docs/subsystems/slots.md#framework-provided-hooks) — the standard props every Slot component receives.
- [ui-primitives](../ui-primitives/README.md) — the `isMobileDevice()` classification.
- [Client test runtime](../../test-support/client-runtime/README.md) — `responsiveHooks()` for hand-built props.

-----

<a id="model-experience"></a>
## Model Experience

None, as media-query and device answers only change browser presentation and register nothing model-facing.

#### KV Cache effect

None; the answers never reach a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Each distinct query string keeps its `MediaQueryList` for the plugin's lifetime. Pass fixed query strings rather than strings built from changing values.
- `useMobile` classifies the user agent and says nothing about input capabilities; `(pointer: coarse)` and `(hover: none)` media queries describe those.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
