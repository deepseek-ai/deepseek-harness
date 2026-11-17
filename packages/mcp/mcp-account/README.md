---
description: "Show the OAuth server account of each MCP connector plugin on the Plugins page: `ctx.mcpAccounts` registers it with the connector account registry and maps the MCP manager's status and authorization to its section, with authorization, sign-out, and restart running on the Host."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-account

English | [中文](README.zh.md)

## Summary

MCP connector plugins such as Linear and Notion register their OAuth server with `ctx.mcpAccounts` to show its account on the Plugins page. The service registers the account with the [connector account registry](../../client/ui-connector-account/README.md) and maps the [MCP manager](../mcp-manager/README.md)'s view of the server to the section: its status, the authorization in progress, and the buttons that apply. Connecting, cancelling, signing out, and retrying run through the manager on the Host. Each connector supplies only the text that names its service. The Web and Desktop compositions load it through [`dsh-web-app`](../../bundle/web-app/README.md).

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

A connector's Host row registers its server with the MCP manager and its account with this service, inside `ctx.inject`, so a composition without the service, such as a headless profile, loads the connector without the page:

```ts ignore-check
import type {} from '@deepseek-ai/dsh-mcp-account'

export function apply(ctx: Context): void {
  ctx.inject(['mcpAccounts'], (scope) => {
    scope.effect(() => scope.mcpAccounts.register({ server: 'acme', packageName: '@acme/connector', copy }), 'acme: Plugins page account')
  })
}
```

- `server` is the name the connector registers with the manager; the account's key in the registry is `mcp:<server>`. A second account for the same server or the same package throws.
- `packageName` is the npm package whose bundle page carries the section and tag.
- `copy` is the `McpAccountCopy` that names the service: the section title, the Connect label, the activation prompt, the detail line of each state, the sign-out confirmation, and the connected and signed-out notices.

The returned disposer withdraws the account from every page.

### What the section shows

| Manager view | Phase | Buttons |
|---|---|---|
| Not listed yet | Checking | None |
| Authorization waiting for the browser | Connecting | Open the authorization page, Cancel |
| Authorization starting, exchanging, or saving the grant | Connecting | Cancel |
| Connected | Connected | Authorize again, which changes the account or workspace and keeps the saved grant until the new one is saved; Sign out, after a confirmation |
| Connecting or reconnecting | Connecting | None |
| Waiting for authorization because no grant exists | Disconnected | Connect; the activation prompt's Connect starts it too |
| Waiting for authorization because the grant expired, no longer matches the settings, was rejected, or lacks a scope | Disconnected, with the reason in the detail | Connect again |
| Closed | Unavailable | Retry, which restarts the server |
| Waiting for credentials, disabled, or failed | Unavailable | Retry only when a restart recovers the failure |

After a failed authorization, a disconnected or unavailable section also shows that authorization did not complete. The line under every section says that authorization completes in a browser on the computer running DSH. A connection and a sign-out report the connector's notice in the browser that started them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`McpAccounts` registers one source per server with `ctx.connectorAccounts`. The source reads the server's entry from `ctx.mcpManager.list()` and calls its observers on each `mcp-manager/status` event for the server. A running authorization attempt is the source's operation, and its identity is the operation's, so the browser that started it follows the manager's own attempt and opens its authorization page. A finished attempt is the result. `start('connect')` answers once the manager has created the attempt; `sign-out` and `retry` answer after the manager signs out or restarts the server, and record their own result so the notice reaches the browser that started them. `cancel` passes the identity to the manager, which ignores any other attempt. `refresh` does nothing, because the manager publishes every change.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ctx.mcpAccounts` service and its registration |
| [`src/account.ts`](src/account.ts) | The server account source, the section's display, and its copy |
| [`src/locales.ts`](src/locales.ts) | The copy every connector shares, in eight languages |
| [`src/types.ts`](src/types.ts) | The registration and connector copy types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector account surfaces](../../client/ui-connector-account/README.md) — the registry and the Plugins page that render the account.
- [MCP manager](../mcp-manager/README.md) — server status, authorization, and sign-out.
- [MCP package group](../README.md) — adjacent MCP packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the account is Plugins page UI and adds no model input. Each connector and the MCP client document the tools a grant exposes.

#### KV Cache effect

None; registering or withdrawing an account changes no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- An account that needs reconnection shows as disconnected; only its status and detail tell it apart from an account that never connected.
- A connector whose Host row fails to load shows no account section; the Plugins page still lists the bundle with its load failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Specs drive the source and the display with a fake manager, and register accounts with the real connector account registry to check keys, routed operations, and withdrawal when the service unloads.

</details>
