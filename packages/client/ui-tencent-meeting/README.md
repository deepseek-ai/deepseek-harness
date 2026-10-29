---
description: "The Tencent Meeting plugin's page on the Plugins page: sign in, check, and sign out of Tencent Meeting without starting a conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tencent-meeting

English | [中文](README.zh.md)

## Summary

This package is the browser row of the [Tencent Meeting plugin](../../connector/tencent-meeting/README.md). While the plugin is on, its page on the **Plugins** page shows a **Tencent Meeting account** section where the user signs in and out without starting a conversation. Every operation runs on the Host through the [`tencentMeeting` Remote](../../connector/tencent-meeting-cli/README.md#account-operations); the page shows its progress and result.

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

Install the [Tencent Meeting plugin bundle](../../connector/tencent-meeting/README.md), which inserts this package as the `ui-tencent-meeting` row. Opening the plugin's page checks the account, and a tag beside the title reads Not connected, Connecting, Connected, Unconfirmed, or Not running. Switching the plugin on from the list while the account is not connected offers **Connect Tencent Meeting**, which opens the plugin's page and starts the sign-in.

| Section state | Action |
|---|---|
| Checking connection | None |
| Not connected | **Connect Tencent Meeting** opens the Tencent Meeting authorization page |
| Waiting for authorization on the Tencent Meeting page | The browser that clicked opens the authorization page once; **Open Tencent Meeting page** opens it again, and **Cancel** ends the sign-in |
| Connecting | None; the Host checks that the server accepts the new sign-in |
| Connected | Shows the signed-in user; **Sign out** asks for confirmation, then signs out |
| Signing out | None |
| Cannot confirm sign-in right now | **Retry** checks the account again |
| Tencent Meeting component not running | The Host's `tencent-meeting` row did not load; the section points to the component list for the reason, and **Retry** subscribes to the Host again |

Below the status, a row reports the Tencent Meeting skill while its guide is not in place: one row while the Host downloads it from GitHub, and after a failed download, one row with **Retry**, which checks the account and restarts the download without waiting for it. Neither row appears once the guide is in place.

Leaving the page does not cancel a sign-in, which the Host owns. The authorization page opens from the user's own click, because browsers block a window that opens long after it. A failed sign-in, sign-out, or check shows the general failure notice with the command and exit code; a failed page action shows a toast, and so does a finished sign-in or sign-out. The section notes that the account is shared with `tmeet` in the computer's terminal and that turning the plugin off does not sign it out, and the sign-out confirmation says that the terminal is signed out too.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half, [`src/index.ts`](src/index.ts), is an empty `apply`, present only so the package holds the Loader row the client module system serves the browser half for. The browser half, [`src/client/index.ts`](src/client/index.ts), mounts the `tencentMeeting` Remote itself with `ctx.remote.$mount`, because the shipped Remote assembly does not include on-demand packages, and withdraws its account registration before unmounting it.

The browser half registers the Tencent Meeting account with the [CLI account surfaces](../ui-cli-account/README.md) through `ctx.cliAccounts`, which follow the `tencentMeeting` Remote and render the section, sign-out confirmation, tag, activation prompt, and toast for `@deepseek-ai/dsh-tencent-meeting`. A link opens only for the operation this browser started, only once, and only over HTTPS. [`src/client/connection.ts`](src/client/connection.ts) derives the account state from the Host's view alone, and [`src/client/account.ts`](src/client/account.ts) maps it to the section's buttons, signed-in user, confirmation, guide download row, and failure guidance. The page's copy, including the keys the shared surfaces read, lives in this package's `tencent-meeting` dictionary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tencent Meeting plugin](../../connector/tencent-meeting/README.md) — the bundle that inserts this row and the Host row.
- [Tencent Meeting CLI and skills](../../connector/tencent-meeting-cli/README.md) — the Host row and the account operations this page drives.
- [CLI account surfaces](../ui-cli-account/README.md) — the registry that follows the Remote and renders this page's account.
- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the bundle slots the account surfaces fill.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side page that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The page checks the account each time it subscribes and has no periodic check, so a sign-in or sign-out in the user's terminal appears after the page reopens.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
