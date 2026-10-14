---
description: "The WeCom plugin's page on the Plugins page: authorize and check WeCom without starting a conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-wecom

English | [中文](README.zh.md)

## Summary

This package is the browser row of the [WeCom plugin](../../connector/wecom/README.md). While the plugin is on, its page on the **Plugins** page shows a **WeCom authorization** section where the user binds a bot by scanning a QR code without starting a conversation. Every operation runs on the Host through the [`wecom` Remote](../../connector/wecom-cli/README.md#account-operations); the page shows its progress and result.

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

Install the [WeCom plugin bundle](../../connector/wecom/README.md), which inserts this package as the `ui-wecom` row. Opening the plugin's page checks the authorization, and a tag beside the title reads Not authorized, Authorizing, Authorized, Unconfirmed, or Not running. Switching the plugin on from the list while it is not authorized offers **Connect WeCom**, which opens the plugin's page and starts the connection.

| Section state | Action |
|---|---|
| Checking authorization | None |
| Not authorized | **Connect WeCom** opens the WeCom QR-code page |
| Waiting for the QR code scan | The browser that clicked opens the QR-code page once; **Open QR code page** opens it again, and **Cancel** ends the connection |
| Confirming authorization | None; the Host checks the result of the scan |
| Authorized | None; WeCom is ready to use in conversations |
| Cannot read authorization right now | **Retry** checks the authorization again |
| WeCom component not running | The Host's `wecom` row did not load; the section points to the component list for the reason, and **Retry** subscribes to the Host again |

Leaving the page does not cancel a connection, which the Host owns. The QR-code page opens from the user's own click, because browsers block a window that opens long after it. A failed connection or check shows the general failure notice with the command and exit code; a failed page action shows a toast, and so does a finished connection. The section notes that the authorization is shared with `wecom-cli` in the computer's terminal and that turning the plugin off does not revoke it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half, [`src/index.ts`](src/index.ts), is an empty `apply`, present only so the package holds the Loader row the client module system serves the browser half for. The browser half, [`src/client/index.ts`](src/client/index.ts), mounts the `wecom` Remote itself with `ctx.remote.$mount`, because the shipped Remote assembly does not include on-demand packages, and withdraws its registrations before unmounting it.

[`src/client/connection.ts`](src/client/connection.ts) creates one `CliAccountConnection` from the [CLI plugin page pieces](../ui-cli-account/README.md) per browser plugin over the `wecom` Remote, and derives the page state from the Host's view alone. That connection opens a link only for the operation this browser started, only once, and only over HTTPS. [`src/client/WecomConnection.tsx`](src/client/WecomConnection.tsx) renders the shared section, tag, activation prompt, and toast with the WeCom actions; the package requests the shared module through `dsh.client.external` instead of bundling it. It registers `plugins.bundle.config` keyed by `@deepseek-ai/dsh-wecom` for the section, `plugins.bundle.activation` for the guidance, `plugins.detail.badge` for the tag, and a `shell.overlay` toast. The page's copy, including the keys the shared pieces read, lives in this package's `wecom` dictionary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WeCom plugin](../../connector/wecom/README.md) — the bundle that inserts this row and the Host row.
- [WeCom CLI and skills](../../connector/wecom-cli/README.md) — the Host row and the authorization operations this page drives.
- [CLI plugin page pieces](../ui-cli-account/README.md) — the shared connection mirror and components this page renders.
- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the bundle slots the page registers into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side page that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The page checks the authorization each time it subscribes and has no periodic check, so an authorization in the user's terminal appears after the page reopens.
- The page offers no disconnect, because `wecom-cli` cannot revoke the authorization.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
