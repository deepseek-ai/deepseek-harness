---
description: "Settings shell, ownerless copy, and durable product-onboarding namespace for the dsh web client: the General section, trigger chrome, and onboarding ledger projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

## Summary

Use this package to give the dsh web client a Settings panel, connection-recovery control, feature-contributed navigation, and sequential first-run onboarding. Users can open it from the sidebar, retry a failed connection immediately, and access a local configuration file when the Host makes one available on a loopback browser. Feature packages supply their own settings rows, sections, and onboarding steps; this package supplies their shared presentation and the Coding Tools switch without adding onboarding copy.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The Settings panel uses a shared 800 × 800 layout, bounded by the viewport. Longer sections scroll inside the content column; the Account entry uses the account icon. The panel portals beside `#root` rather than inside it, so a macOS window drag region a chrome row declares later in document order cannot swallow its controls.

<a id="use-this-package"></a>
## Use this package

Users reach the shell through the sidebar's bottom Settings control; feature plugins contribute their pages and onboarding steps through the slot ledgers this shell projects. In both the expanded sidebar and collapsed rail, the control exposes the localized Settings label as its accessible name. A pale-yellow **Disconnected** action beside Settings indicates browser offline suspension; its permanent retry glyph marks the retry action, which the Chinese outage copy also names (连接异常，刷新重试). Every recovery attempt shows the shared ongoing loader beside **Reconnecting** with one to three dots advancing every 500ms, and an attempt stays visible for at least 800ms so brief retries do not flicker. Selecting either yellow state starts an immediate retry; press feedback stays within the warning palette. Recovery changes the region to pale-green **Connected** for two seconds from the moment the green pill becomes visible. The pill fades in on appearance, fades out over 150ms on removal, and sizes to its current label. Initial startup and uninterrupted healthy operation remain silent. The shell renders the modal panel, the navigation built from `settings.section` entries, and exactly one mounted onboarding step at a time.

Settings uses the [frame’s shared overlay inset](../ui-layout/README.md#window-chrome-seat) and keeps at least 24px of viewport margin. Its mask leaves the Windows caption unpainted; the full-viewport layer still blocks background clicks.

When the section navigation exceeds the panel's available height, the list scrolls independently of the settings content and keeps the Settings title fixed.

In Desktop, the account-row update control shows availability, progress, verification, readiness, and persistent retry feedback. It shares the connection indicator’s 28px height, 8px corners, 14px icon slot, 4px icon gap, and 12px medium text with an 18px line height; update-state border, fill, and text colors remain independently defined. Retry text and its dot use the same brand blue as other update labels; numeric download progress has no ellipsis. The preload carries semantic phase, version, progress, and classified failures; the component resolves every visible and accessible string from the active `settings` locale, including after an in-application language change. Selecting an available update starts downloading; installation requires a separate shell-owned confirmation. A collapsed sidebar shows the same status as a brand-blue dot on its top expand button, including failures. Connection feedback takes priority except during shell-reported installation, when the expected backend disconnect must not hide update status. Failure restores connection feedback. Both controls share one carrier subscription; browser code cannot choose packages or authorize installation. [Desktop updates](../../../apps/desktop/README.md) owns the release workflow. Checking, verifying, and preparing-to-restart tooltips show only the supplied version; without a version, they retain the state label. Desktop update tooltips preserve the complete version and prerelease suffix without adding v or V; their error summaries match the shell update dialogs.

Settings visibility and section selection live in the shell owner store. The shell supplies the effective Settings binding to the contributed launcher for menu keycaps and `aria-keyshortcuts`; the fallback button uses the same binding for hover and keyboard-focus hints and `aria-keyshortcuts`. The Settings command (Desktop: `Mod+,`; Windows/macOS Web: `Mod+Alt+,`) toggles the dialog when Settings is in front or no modal is open; the sidebar control opens the same dialog. The command cannot open or close Settings while the shortcut reference or another modal is in front. Held-key repeats do nothing. Initial focus lands on the selected section in the navigation, or on the title when no sections are available, without drawing a focus outline. Tab and directional navigation retain their visible focus indicators. `Mod+/` can open the shortcut reference above Settings; `Escape` closes the top dialog and restores focus to its invoking control. Return focus omits outlines after shortcut, Escape, or pointer dismissal.

### The General section

The current release version appears at the bottom of General Settings in Web and Desktop, using the build’s `DSH_CLIENT_VERSION` metadata and the active language. Partial builds without version metadata omit the row.

The Coding Tools switch controls the shared `ui-settings.enabled` preference described by [ui-settings](../ui-settings/README.md#use-this-package). It is available in both Web and desktop, follows accepted changes immediately, and disables duplicate input while a write settles. A failed write displays localized retry guidance.

The General section holds the built-in Coding Tools and Current version rows alongside rows registered into `settings.general.item` by feature packages. Each registrant owns its row copy and behavior. The Appearance row, for example, lives in ui-theme.

### Opening the configuration file

On a loopback browser, the shell renders **Open configuration file** only when the Host confirms that a provider-owned local document can be prepared. The action opens that document in the native text editor (bypassing the browser file association on macOS). Remote browsers never register the action and never issue the privileged settings read.

### Onboarding steps

The onboarding ledger projects in ascending order and mounts exactly one step at a time. Registrants own durable completion, capability readiness, copy, mutations, and their visible wrapper, so independently registered flows cannot stack and the shell does not become a second configuration fact source. Visible steps own their dialog chrome and app-root `inert` lifecycle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The shell declares settings.launcher for an account-owned sidebar menu and retains the Settings button as its fallback. The launcher receives settingsOpen, whose false-to-true edge marks one Settings entry, so a registrant acts once per entry instead of on every re-render inside one open. Closing the dialog returns focus to the active launcher.

<details>
<summary>Implementation internals — click to expand</summary>

The shell owns the chrome and the projections; it contributes the Coding Tools and Current version rows, while feature registrants own their additional content and copy.

### Ledger projections

The navigation is a projection of the `settings.section` ledger; nav labels may be locale-following thunks, resolved through `resolveSlotLabel` and re-rendered on the section ledger bump or the locale revision (an optional `ctx.get('locale')` read; no hard locale dependency). The onboarding ledger projects in ascending order; the active registrant receives its id, `complete()`, and an `openSection(id)` callback, and completing or skipping transfers ownership to the next entry.

### Connection recovery

The shell is an explicit recovery consumer, so it injects Connection directly rather than adding lifecycle controls to `ctx.remote`. Its private hooks compartment binds `ctx.connection.state`, while the component receives only the selected state and an injected callback for `ctx.connection.reconnect()`. `ConnectionIndicator` owns the inline presentation and receives all visible and accessible copy from the `settings` locale namespace; the shell owns the 800ms minimum-visible hold for the connecting state and the two-second recovered-state timer, which starts when the recovered pill becomes visible after the hold.

### Document availability

On a loopback page, the Client loads the provider's `hasDocument` capability through `settings/describe` and renders **Open configuration file** only when the Host confirms that a provider-owned local document can be prepared. The action calls the pathless, browser-authenticated `settings/openSettingsDocument` Remote; the Host resolves the provider path again, materializes an absent document, and hands it to a native text editor (`open -t` on macOS, bypassing a browser file association; the desktop file association on Linux and Windows; Windows association after `wslpath -w` translation on WSL). Open failures keep the action available and render a localized error. Reopening the dialog or reconnecting refreshes availability after a transient read failure or Host topology change. Non-loopback pages retain the Client policy that withholds this native action and its settings read.

### Host half

The Host half declares `welcomeNoticeVersion` as a volatile field of the `ui-settings-general` entry Config. The welcome step contributed by ui-settings-models reads and writes its `welcomeNoticeVersion` through the existing public settings boundary; the shell itself remains policy-free.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings surface family and the composition model.

- [ui-settings](../ui-settings/README.md) — the domain base whose slot types and scope service this shell builds on.
- [ui-sidebar](../ui-sidebar/README.md) — the sidebar shell hosting the `sidebar.settings` seat.
- [ui-settings-models](../ui-settings-models/README.md) — the feature package contributing the DeepSeek onboarding step.
- [settings](../../settings/README.md) — the durable user-settings seam and its file provider.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the composition model behind the ledgers.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the shell itself provides versus what features must supply; they are current package constraints.

- **Additional General rows require their feature plugins** — the shell supplies Coding Tools and Current version; feature plugins supply the remaining preferences.
- **The Windows caption badge keeps a side-opening bubble** — `DesktopUpdateBadge` occupies `sidebar.toggle.badge` in the caption and requests `side="right"`, so the Desktop-owned menu text can cover its bubble while the sidebar is collapsed on Windows; the sidebar toggle and New Session bubbles open below the caption instead (#4688).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
