---
description: "Register an MCP connector's OAuth account on the Host with `ctx.mcpAccounts` and show its section, title tag, activation guidance, sign-out confirmation, and notices on the Plugins page through one `mcpAccounts` Remote, with the connector's own text and the shared copy of this package."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mcp-account

English | [中文](README.zh.md)

## Summary

Connector plugins that register an OAuth MCP server with the [MCP manager](../../mcp/mcp-manager/README.md) register its account on the Host with `ctx.mcpAccounts` to show it on the Web sidebar's **Plugins** page. The registry serves every account, with the manager's view of its server, through one `mcpAccounts` Remote. The browser half renders each account's section, title tag, activation guidance, and notices, and authorizes, cancels, signs out, and retries through the manager's Remote. Connectors supply the text that names their service as `LocalizedText`; the shared copy comes from this package's dictionary. The Web and Desktop compositions load both halves through [`dsh-web-app`](../../bundle/web-app/README.md).

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

A connector's Host row registers its account once; the connector ships no browser code for the account.

### Register an account

The connector's Host row registers its account while the registry runs, so a composition without the registry, such as a headless profile, skips the registration:

```ts ignore-check
import type {} from '@deepseek-ai/dsh-client-ui-mcp-account'

export function apply(ctx: Context): void {
  ctx.inject(['mcpAccounts'], (scope) => {
    scope.effect(() => scope.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', copy }), 'docs: Plugins page account')
  })
}
```

`server` is the name the connector registers with the MCP manager, and `packageName` is the npm package whose bundle page carries the section and tag; a second registration for the same package or server throws. `copy` holds every string that names the service: the section title, the Connect label, the activation guidance, the detail line of each state, the sign-out confirmation with what signing out removes, and the connection and sign-out notices. Each string is `LocalizedText`, which each browser resolves in its active language. The connector imports the registry's types with `import type`. The returned disposer withdraws the account from every page.

### What the page shows

| Section state | Action |
|---|---|
| Not connected, or the grant expired, no longer matches the server address or OAuth options, was rejected, or lacks permissions | Connect starts an authorization attempt |
| Waiting for you to confirm in the browser | The browser that started the attempt opens the authorization page once; Open authorization page opens it again, and Cancel ends the attempt |
| Connected | Sign out asks for confirmation, then deletes the local grant |
| Cannot connect right now | Retry restarts the server and keeps the existing grant; after incomplete cleanup only a Host restart recovers, so Retry is not offered |

The tag beside the bundle title reports the same states while the bundle is enabled. Switching the bundle on while no account is connected offers to connect, which opens the bundle page and starts authorization. Leaving the page does not cancel an attempt, which the Host owns.

### Following attempts

Each browser opens one stream when the Web app loads. The browser that starts an attempt opens its authorization page once, only when the URL uses HTTPS or loopback HTTP, and reports the connection; other browsers show the same section but open no page and report no notice. An account the Host withdraws drops the attempt this browser followed. Clicks while an action is pending are ignored.

### Failures

A failed attempt shows an alert under the status line; a failed page action shows a toast, and the Host keeps the diagnostic. While the stream is not delivering, every action stays disabled.

### Shared copy

The `mcpAccount` dictionary holds the copy every account shares: the status lines and tags, the expired, mismatched, and unavailable details, the hint that authorization happens on the Host computer, the failure alert and notice, and the action labels. Every other string comes from the connector.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half, `McpAccounts`, is a Remote service that injects the MCP manager. `register()` stores the account, and each `watch` stream follows the manager's own `watch` stream: once the manager lists its servers, it yields every account with its server's view after each change of either, coalescing changes that arrive before the next read. It rethrows a failure of the manager's stream and ends with it.

The browser half mounts the `mcpAccounts` Remote and opens one `watch` stream through `McpAccountsConnection`, which keeps one snapshot store per account: the Host entry, whether the stream is delivering, whether an action this browser started is pending, and the latest notice. Its actions call the manager's `startAuthorization`, `cancelAuthorization`, `signOut`, and `restart` with the account's server. For each account the Host reports, it registers `plugins.bundle.config` and `plugins.bundle.activation` keyed by the package name, a `plugins.detail.badge` entry with id `<server>.connection`, and a `shell.overlay` toast with id `<server>.connection-toast`, all under the `mcpAccount` namespace and injecting one face. An account the Host drops loses its four entries, and unloading withdraws the entries and the stream before the Remote.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ctx.mcpAccounts` registry and its Remote |
| [`src/types.ts`](src/types.ts) | The registration, copy, and stream item types |
| [`src/client/index.ts`](src/client/index.ts) | The browser entry bound to the generated Remote |
| [`src/client/mount.ts`](src/client/mount.ts) | The Remote mount, the dictionary, and the slot registrations of each account |
| [`src/client/connection.ts`](src/client/connection.ts) | The presentation, the stream mirror, authorization page opening, notices, and the pending-action guard |
| [`src/client/McpAccount.tsx`](src/client/McpAccount.tsx) | The four surfaces |
| [`src/client/locales.ts`](src/client/locales.ts) | The shared dictionary |
| [`src/client/types.ts`](src/client/types.ts) | Snapshot, notice, and face types |

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

None, as the registry and its surfaces are Plugins page UI and add no model input. The connector's naming guidance and the server's tools are documented by the connector and the [MCP client](../../mcp/mcp-client/README.md#model-experience).

#### KV Cache effect

None; registering or removing an account changes no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The section exists only while the connector plugin is on. To sign out after turning the plugin off, turn it on again or delete the grant record.
- A connector whose Host row fails to load shows no account section; the Plugins page still lists the bundle with its load failure.
- The authorization callback is the Host web server's own origin, so the browser that completes authorization must reach that server directly, not through a proxy or the Web app's `publicUrl`.
- One grant serves each server on the Host; there is no account picker.
- The Web and Desktop compositions load the registry whether or not a connector is installed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host specs drive the registry with a fake manager stream. Client specs drive `McpAccountsConnection` with a fake Remote stream, render the surfaces with a key-echo translator and Chinese connector text, and mount the browser half against a real slot registry and locale runtime. Source coverage excludes `src/client/index.ts`, which imports the generated Remote that exists only in `lib/`.

</details>
