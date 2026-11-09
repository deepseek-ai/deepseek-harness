---
description: "Display account notifications and refresh their localized content."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-account-notifications

English | [中文](README.zh.md)

## Summary

Show server-authored account notifications beside the account menu. Displayed cards survive later list omissions and refresh their content when the interface language changes.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Web bundle includes this plugin with [account settings](../ui-settings-account/README.md). It contributes to `settings.launcher.notifications`; the account menu supplies visibility and the action that opens Account settings. The notification plugin owns cards, polling, localized content, and interaction reports.

Startup with a stored account, sign-in, and each Settings entry start a new polling cycle with an immediate request. `notificationPollIntervalMs` on the `ui-account-notifications` row supplies the initial delay, defaulting to 600,000 ms. A successful list response replaces it with `next_poll_after` seconds, including empty lists. The delay starts after the request settles; failures retain the latest delay, and restarting restores the configured initial value. Polling continues in the background.

Account settings owns the sole account stream and exposes its current state and lifecycle events through `accountUi` and `account-ui/change`. Login-progress updates retain cards and polling. Credential replacement, disconnection, access revocation, sign-out, and plugin disposal clear cards, stop polling, and discard late replies. Notification requests do not wait for profile or avatar data. Notification state is not stored in the browser.

Cards render inside the sidebar above the account launcher and below menus and dialogs without taking focus. Their width follows the expanded launcher up to 280px, leaving 10px on the left and at least 10px on the right. Collapsing the sidebar hides the cards; expanding it restores them without another display report. Closing a card promotes the next with a 250ms position and scale transition, disabled by reduced-motion preferences.

Notifications wait for Desktop and model-credential onboarding to finish. Only the foreground card is interactive and reports `displayed`, once per mount after a painted frame while it intersects the viewport and the sidebar and document are visible. The Settings overlay does not exclude that frame. A displayed foreground card remains until close or expiry even when a later list omits it; waiting cards follow server order.

Each card uses the server's plain-text title, body, and ordered primary or secondary buttons. Every non-dismiss action reports `cta_clicked` with the notification ID, executes immediately, and retains the card; the account action opens Account settings. Closing through the close button or a dismiss action reports only `dismissed` as the card is removed, before the next card moves into place. Closing before the first painted frame does not report `displayed`. Expiry and account cleanup do not report dismissal. Click reports contain no action ID or target.

Each interaction is reported once without waiting or retrying; either boolean acknowledgement completes that attempt. A failed report logs a diagnostic without an account UI error or undoing the interaction. The server owns consumption: a later list may offer a closed card again. List failures keep the current cards.

Switching language requests current cards through the content endpoint, including consumed cards, without another list query or display report. Content updates preserve card identity, order, and focus. Failed reads retain the previous text and log a diagnostic; replies for an older language, signed-out account, or closed card cannot restore stale content.

<a id="model-experience"></a>
## Model Experience

None, as notifications remain client presentation data and never enter model requests or Session logs.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Cards retain the existing expiry and foreground-retention behavior. Server copy is plain text; supported actions dismiss the card or open Account settings. Network failures keep current cards and resume on the next poll.

<a id="dev-note"></a>
### Dev Note

The package tests cover lifecycle ownership; the Web notification scenario checks the assembled account menu.
