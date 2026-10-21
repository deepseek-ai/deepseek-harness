---
description: "The Plugins page account surfaces for connector plugins that register an OAuth MCP server: the account section, title tag, activation guidance, and notices; for connector authors and maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mcp-account

English | [中文](README.zh.md)

## Summary

This package gives connector plugins their account interface on the Web sidebar's **Plugins** page. A connector whose Host half registers an OAuth MCP server with the [MCP manager](../../mcp/mcp-manager/README.md) calls `ctx.mcpAccounts.register()` from its browser half with the server name, its bundle package, and its dictionary namespace. The package then shows the account section on that bundle's page, the connection tag beside its title, guidance after the bundle is switched on, and connection notices. Authorization, status, and sign-out go through the manager's Remote; the page keeps no connection state of its own. The Web and Desktop compositions mount it through [`dsh-web-app`](../../bundle/web-app/README.md).

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

### Register an account

A connector's browser half injects `locale` and `mcpAccounts`, registers its dictionary, and registers its account for its own lifetime:

```ts ignore-check
export const inject = ['locale', 'mcpAccounts']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'docs: dictionaries')
  ctx.effect(() => ctx.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', locale: NS }), 'docs: account')
}
```

`server` is the name the connector's Host half registers with the MCP manager, and `packageName` is the npm package whose bundle page carries the section and tag. `locale` names the connector's dictionary namespace; its `LocaleNamespaceMap` entry must be exactly `McpAccountKey`, and the dictionary supplies every product string, including the service name and what sign-out removes. The connector lists `@deepseek-ai/dsh-client-ui-mcp-account` in `dsh.client.inject`. The returned disposer removes the surfaces and closes the account's manager stream. A registration whose package or server is already registered throws and leaves none of its surfaces behind.

### What the page shows

| Section state | Action |
|---|---|
| Not connected, or the grant expired, no longer matches the server address or OAuth options, was rejected, or lacks permissions | Connect starts an authorization attempt |
| Waiting for you to confirm in the browser | The browser that started the attempt opens the authorization page once; Open authorization page opens it again, and Cancel ends the attempt |
| Connected | Sign out asks for confirmation, then deletes the local grant |
| Cannot connect right now | Retry restarts the server and keeps the existing grant; after incomplete cleanup only a Host restart recovers, so Retry is not offered |

The tag beside the bundle title reports the same states while the bundle is enabled. Switching the bundle on while no account is connected offers to connect, which opens the bundle page and starts authorization. Leaving the page does not cancel an attempt, which the Host owns.

### Failures

A failed attempt shows an alert under the status line; a failed page action shows a toast, and the Host keeps the diagnostic. While the manager stream is not delivering, every action stays disabled. The page opens an authorization URL only for the attempt this browser started, and only when the URL uses HTTPS or loopback HTTP.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`register()` creates one `McpAccountConnection` per account. It mirrors the manager's `watch` stream, derives the presentation from that server's entry alone, and keeps only whether the stream is delivering, whether a page action is pending, and the latest notice. The registration contributes `plugins.bundle.config` and `plugins.bundle.activation` keyed by the package name, a `plugins.detail.badge` entry with id `<server>.connection`, and a `shell.overlay` toast with id `<server>.connection-toast`. Each entry declares the connector's namespace, so the renderer supplies its `t`, and all four inject one face that shares one snapshot. The registration is one effect of this plugin's fiber: a setup failure disposes what it already added, and teardown removes the slot entries before closing the stream, whichever of the connector's disposer and this plugin's unload runs first.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP manager](../../mcp/mcp-manager/README.md#oauth-authorization) — the `watch`, `startAuthorization`, `cancelAuthorization`, `signOut`, and `restart` operations behind the page.
- [Plugins page](../ui-plugin-manager/README.md#use-this-package) — the bundle page slots this package registers into.
- [MCP subsystem](../../../docs/subsystems/mcp.md) — how the MCP packages fit together.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the account surfaces are browser UI and add no model input. The connector's naming guidance and the server's tools are documented by the connector and the [MCP client](../../mcp/mcp-client/README.md#model-experience).

#### KV Cache effect

None; registering or removing an account changes no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The section exists only while the connector plugin is on. To sign out after turning the plugin off, turn it on again or delete the grant record.
- The authorization callback is the Host web server's own origin, so the browser that completes authorization must reach that server directly, not through a proxy or the Web app's `publicUrl`.
- Each account opens its own manager stream.
- One grant serves each server on the Host; there is no account picker.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Client specs drive `McpAccountConnection` with a fake manager stream, render the four components with a key-echo translator, and register accounts against a real slot registry.

</details>
