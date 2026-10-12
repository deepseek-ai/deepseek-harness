---
description: "The Feishu plugin's page on the Plugins page: connect, check, and sign out of the Feishu account without starting a conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-feishu

English | [中文](README.zh.md)

## Summary

This package is the browser row of the [Feishu plugin](../../connector/feishu/README.md). While the plugin is on, its page on the **Plugins** page shows a **Feishu account** section where the user links a Feishu app, signs in, and signs out without starting a conversation. Every account operation runs on the Host through the [`feishu` Remote](../../connector/feishu-cli/README.md#account-operations); the page shows its progress and result.

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

Install the [Feishu plugin bundle](../../connector/feishu/README.md), which inserts this package as the `ui-feishu` row. Opening the plugin's page checks the account, and a tag beside the title reads Not connected, Connecting, Connected, or Unconfirmed. Switching the plugin on from the list while no account is connected offers **Connect Feishu**, which opens the plugin's page and starts the connection.

| Section state | Action |
|---|---|
| Checking connection | None |
| Not connected | **Connect Feishu** links an app when none exists, then signs in |
| Step 1: Link a Feishu app, or Step 2: Sign in to Feishu | The browser that started the connection opens each Feishu page once; **Open authorization page** opens it again, and **Cancel** ends the connection |
| Connected | **Sign out** asks for confirmation, then signs out the CLI's default account |
| Cannot confirm sign-in right now | **Retry** runs the connection again and keeps the existing setup and sign-in |

Leaving the page does not cancel a connection, which the Host owns. A failed connection or sign-out shows **The action did not finish. Try again.** in the section; a failed page action shows a toast, and so does a finished connection or sign-out. The section notes that the account is shared with the Feishu CLI in the computer's terminal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half, [`src/index.ts`](src/index.ts), is an empty `apply`, present only so the package holds the Loader row the client module system serves the browser half for. The browser half, [`src/client/index.ts`](src/client/index.ts), mounts the `feishu` Remote itself with `ctx.remote.$mount`, because the shipped Remote assembly does not include on-demand packages, and withdraws its registrations before unmounting it.

One `FeishuConnection` per browser plugin, in [`src/client/connection.ts`](src/client/connection.ts), mirrors the Remote's `follow` stream and derives the page state from the Host's view alone; it keeps only whether the stream is delivering, whether a page action is pending, the operation this browser started, and the latest notice. It registers `plugins.bundle.config` keyed by `@deepseek-ai/dsh-feishu` for the section, `plugins.bundle.activation` for the guidance, `plugins.detail.badge` for the tag, and a `shell.overlay` toast. It opens a link only for the operation this browser started, only once, and only over HTTPS. The page's copy lives in this package's `feishu` dictionary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu plugin](../../connector/feishu/README.md) — the bundle that inserts this row and the Host row.
- [Feishu CLI and skills](../../connector/feishu-cli/README.md) — the Host row and the account operations this page drives.
- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the bundle slots the page registers into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side page that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The page checks the account each time it subscribes and has no periodic check, so a sign-in or sign-out in the user's terminal appears after the page reopens.
- Every failed operation shows the same retry message; the Host keeps the diagnostic.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
