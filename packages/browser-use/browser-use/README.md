---
description: "Browser-use provider registration for deployments that enable one browser backend at a time."
kind: "package-reference"
---

# @deepseek-ai/dsh-browser-use

English | [中文](README.zh.md)

## Summary

A deployment can enable one browser-use provider at a time. Loading another provider fails with the registered provider name. Each provider supplies its own tools and owns browser sessions. This package adds no model-visible tools or browser operations.

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

Mount the service once beside the chosen provider in a Cordis composition:

```yaml
- name: '@deepseek-ai/dsh-browser-use'
```

The service has no configuration. Provider plugins inject `browserUse` and call `ctx.browserUse.register(BrowserUseProviderName(name))`; the brand is exported from `@deepseek-ai/dsh-browser-use/brand`. The returned effect disposer releases that registration.

Providers stop admitting tool calls, close their resources, and await owned work before releasing the registration. `ctx.browserUse.providerName` reports the registered name until release.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One private name owns the slot. Cordis effects remove contributions when their plugin unloads; a repeated disposer cannot remove a later registration. The [source](src/index.ts) contains no browser object, operation interface, resource lifecycle, or provider selector.

No runtime invariant companion is published: the registry has one authoritative field and exposes no independently maintained observation that can diverge. Duplicate rejection and plugin disposal are covered by the owning tests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Playwright MCP provider](../../experimental/browser-use-playwright-mcp/README.md) — Playwright browser tools.
- [Chrome DevTools MCP provider](../../experimental/browser-use-chrome-devtools-mcp/README.md) — Chromium inspection and control.
- [Stagehand provider](../../experimental/browser-use-stagehand-native/README.md) — native browser operations with AI assistance.

-----

<a id="model-experience"></a>
## Model Experience

None, as this registry only records provider names.

#### KV Cache effect

Registration does not alter model requests. Provider-owned tools and guidance determine their own request-prefix effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The service limits registrations within its Cordis service instance.

- **Browser ownership** — providers own browser resources and enforce Session isolation; this service stores no browser state.
- **Provider selection** — configuration selects the provider; the model cannot switch registered backends at runtime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
