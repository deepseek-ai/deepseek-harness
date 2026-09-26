---
description: "Browse the commands available in the current window and find them by action, English alias, or key"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-shortcuts

English | [中文](README.zh.md)

## Summary

Browse the commands available in the current window and find them by action, English alias, or key. Open the reference from General Settings or Mod+/. Record, clear, or restore application bindings; fixed input actions remain read-only.

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

The Web app bundle mounts this package together with `shortcuts`. The reference shows only registered commands and existing fixed input actions. Desktop shows the effective device keys; commands without a Web default show No shortcut. The Settings entry and Mod+/ open the same single dialog, titled “Keyboard shortcuts” in English and “快捷键” in Chinese. Its 480×600 CSS-pixel card shrinks to fit smaller windows; the header and search remain above an internally scrolling list. The search field receives focus on open without changing its border color. Automatic entry and return focus in the reference, recorder, and reset confirmation omit outlines, including returns after Escape and application close shortcuts. Containers remain outline-free, and Tab and directional navigation retain their visible focus indicators. The Settings entry is labeled “Edit shortcuts”, with an “Open from anywhere” shortcut tooltip, and uses a filled button with the same standard radius as adjacent settings controls and no dropdown icon and reads the same effective binding for its tooltip and `aria-keyshortcuts`; both are absent without a binding.

`Mod+/` opens the reference when no modal is open or Settings is in front, and closes it when the reference is in front. While the reference is in front, the Settings command cannot open or close Settings. Held-key repeats are ignored. Recording, pending writes, and a nested confirmation prevent the reference shortcut from closing the dialog.

Core actions follow a fixed product order, independent of plugin registration, unloading, or remounting. Stopping the current response ends the Message input group and remains read-only. Extension commands outside that order follow the core actions in stable command ID order; other fixed actions retain their groups.

Search matches an ordered subsequence within one label, English alias, or key combination, ignoring case. Each matching command appears once. Search relevance takes precedence; equal matches retain the display order. Application and fixed-action rows remain 42 CSS pixels high during normal display and recording; long command names are truncated. Application rows show command names and binding controls without availability subtitles or reason tooltips, including conflicting and invalid bindings. Commands that cannot execute remain silent. Both platforms show each editable row’s complete key combination in one settings-control grey block with secondary ink. Fixed actions use unboxed tertiary text, cannot enter recording, and do not highlight on hover. Group titles align with command labels.

Hover an application row to highlight its rounded surface and reveal the edit icon; keyboard focus also reveals the icon. Clicking anywhere on the row starts its inline recorder. Unbound commands omit the inline Remove action. Windows and macOS Desktop record one or two overlapping non-modifier keys with optional modifiers; a third key rejects the draft. Releasing the first key saves the current combination, so sequential A then B records only A. Saving rejects combinations occupied by editable or fixed actions, including overlapping single-key and two-key bindings. The dialog close control exits recording. The recorder keeps the same height as key badges and uses a neutral grey border with secondary text. Other environments retain Escape cancellation and Tab navigation. Saving and cancellation return focus to the dialog. Clicking blank dialog space outside the inline editor closes it and discards any held combination; clicking its status text preserves the draft. macOS Web can record Option+Command+N reported as a dead key; composition and ordinary accent input remain protected. Remove clears the binding; Restore Default removes only that command’s override. System toasts announce successful writes and failures; a rejected combination marks the recorder with an error border. Release its non-modifier keys to record another combination without clicking; modifiers may remain held. Repeated identical errors leave a visible toast and its dismissal time unchanged; different errors and successful writes replace it immediately. An error can appear again after dismissal. Failed writes retain recorder focus and the draft for Retry Save or another recording. Configuration or command-catalog changes require review before a draft can be retried. Read failures disable editing and identify the active bindings and affected document in a system toast: Web uses the current origin’s localStorage entry `dsh.keybindings.v1`; Desktop uses `userData/keybindings.json`. Back up and repair damaged data before reloading the page or restarting Harness; upgrade Harness for a document written by a newer version. Restore All never overwrites unreadable data. The footer shows Restore All Defaults and the current runtime/platform’s override count, including removed bindings and commands that are not currently mounted. Search does not change the count. At zero overrides, the count is hidden and the action is disabled. Its confirmation initially focuses Cancel; cancellation returns focus to Restore All Defaults, including when opened from the recorder. Confirming restores only this profile. A stale revision closes the confirmation and requires another confirmation against the latest configuration; a failed write retains the accepted bindings and allows retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The General Settings entry and shell overlay share one declared interaction store. Catalog and configuration updates arrive through injected observable hooks; recording and persistence use injected service callbacks. The shared modal primitive owns top-layer Escape, Tab traversal, and restoration to the invoking control.

All fixed actions come from the service's observable fixed catalog. Conversation and approval plugins contribute their own actions; this integration contributes shared menu actions. Rows follow locale updates and disappear when their registration is disposed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web Client](../../../docs/subsystems/web-client.md)
- [UI primitives](../ui-primitives/README.md)
- [Web app bundle](../../bundle/web-app/README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Loading or unloading command owners invalidates an open recording draft even when saved overrides are unchanged; review the current bindings before retrying.
- Key recording uses physical positions with US-layout key names. Browser combinations are limited by the [shortcut service](../shortcuts/README.md). Only mounted feature owners contribute approval and double-Escape stop rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Slot registration validates ownership; the view derives its rows from the shortcut catalog without a second mutable registry.
