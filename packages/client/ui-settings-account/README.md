---
description: "Desktop Account settings display DeepSeek login state and offer browser authorization and cancellation; the sidebar account menu provides Platform sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

English | [中文](README.zh.md)

Server-expired account credentials clear the displayed account details and emit a localized sign-in reminder toast once; account snapshot replay does not repeat it.

## Summary

The Account settings section displays DeepSeek login state and offers browser sign-in and cancellation; the sidebar account menu provides Platform sign-out. Desktop users also receive a resumable introduction to account credit and presentation preferences.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

A new account-model sign-in-required event displays “Model unavailable. Please sign in and try again.” in a toast. The notice is transient: remounting or refreshing does not replay it.

<a id="use-this-package"></a>
## Use this package

The client activates only inside Desktop, identified by its preload bridge. Plain Web clients keep the standard Settings launcher and API-key onboarding without account login, account settings, or an account-state subscription.

The sidebar and Account settings display circular profile images with diameters of 24px and 32px respectively, with the account icon as fallback when the URL is absent or the image fails to load. The collapsed sidebar centers the avatar in a 36 × 36 px button. Before sign-in the sidebar launcher shows a More row instead, leading with the ellipsis glyph.

The section registers through settings.section and uses the account Remote namespace. The stream survives carrier reconnects through the shared Remote supervisor. The page renders feature-owned English and Chinese copy and keeps API keys separate from account state.

Account operations carry this UI's client identity to the Host: build version, active language, and the current UTC offset in seconds sampled as the operation is issued.

Balances use Platform Web currency formatting: two decimal places and digit grouping, positive amounts truncated to cents, positive sub-cent amounts shown as <0.01, and negative amounts rounded with a minimum displayed magnitude of 0.01. Raw Host balance strings remain unchanged.

Desktop usage, top-up, and onboarding recharge actions open one isolated native Platform view below a 48px return bar. The Desktop host owns a single such view, and opening a page destroys the previous one, so the plugin registers one shared host entry in `shell.overlay` and the Account settings page, the account quota notice, and the Desktop onboarding recharge page all request a page through its `PlatformPages` request channel instead of mounting their own container. Each request retires the previous owner before the newer page shows, and its identity-safe release clears only that request, so a stale owner cannot close a page it no longer owns. On Windows Electron the return bar and the native view start below the Desktop caption strip, so the Application and Edit menu text cannot cover the Back to DeepSeek Harness label. Back destroys the view, restores focus before any deferred Modal takes it, and preserves the Account settings page. Leaving a top-up page waits for any read already running and then reads again, because a top-up may have changed what the account holds. The Account settings page and the account quota notice re-read profile, balance, and unnotified bonus; the onboarding recharge return re-reads profile and balance only, so it never triggers the unnotified-bonus read. Superseding a page, releasing a request, plugin unload, and leaving usage all read nothing. Loading failures retain the return action and show a centered localized error with Retry. Retry reloads the same destination; renderer commands never receive the account token.

Chat offers each live quota failure from a bound Session to the frame-wide `shell.quota-notice` chain from its host in `shell.overlay`, so the notice outlives the Chat panel that reported it. The account entry claims `ACCOUNT_QUOTA`: while an account credential is stored and the shared host entry exists, the Modal offers Cancel and Top up. While a page requested through the shared request channel is showing, the native view covers this document, so the entry paints neither the Modal nor the Toast. A quota failure that arrives while a Settings-opened page is already showing is not retained: it stays subject to newest-notice replacement, and the Modal appears after the viewer returns while that notice is still current. That Modal reports the failure of the original request, not the account's current balance: the top-up re-read is a separate read, and returning neither proves a successful payment nor dismisses the notice on its own. The notice's own Top up is the retained case: it calls `keepOpen()` and requests the `top-up` page through the shared request channel, keeping that notice and its page mounted through later quota failures. With the shared host entry the entry waits for the first account snapshot instead of rendering a Toast that its own timer could discard; a snapshot that reports no stored credential, or a failed account stream with no snapshot, then renders the same neutral warning Toast itself, and without that host entry the entry renders that Toast immediately, instead of relying on the chat host fallback. The entry owns the hold and its page request and releases both when it unmounts, so a later quota failure publishes again without replaying the dropped ones; dismissal or sign-out clears the hold and the page request. Close, Cancel, a sign-out, or leaving the notice's own embedded page takes the notice down without retrying the request.

The account menu's Feedback entry opens the Feishu questionnaire in the system browser. It supplies the available build version, UI locale and physical screen resolution as prefill_* parameters, with hide_*=1 for every context field; the account UID, tokens and contact details are excluded. Configure contactFormUrl on the ui-settings-account plugin to select another HTTPS form. contactSource defaults to empty until the questionnaire supports a Harness source option; OS and device fields remain unfilled, matching the Web implementation.

Account profile and balance cards share the [settings card material and radius](../../../docs/web-styling.md#corner-radii-and-settings-cards). Usage and top-up links match standard Button geometry; authorization actions use the shared Button.

The sidebar account menu uses the shared Menu surface and backdrop blur. The signed-in menu keeps the shared row typography; the signed-out menu carries its own wider rows and its Contact us copy for the Feedback entry. Its Settings row shows the effective key combination supplied by the shell. Closing Settings returns focus to the sidebar account launcher.

The account card’s More account information link has no underline and opens the root of the Host-provided Platform usage URL in the system browser, following `platformOrigin`.

Sign out first queries running account-token tasks and opens a confirmation dialog. The warning describes interruption when such tasks exist; otherwise it explains that data is retained and the account can be signed in again. Cancel, close, and Escape dismiss without signing out. Failed impact queries still open confirmation with an explicit unknown-task warning; failed sign-out keeps the dialog available for retry.

A granted bonus appears as a server-authored notice above the sidebar account launcher without taking focus. The client reads the unnotified bonus when an account becomes active and once per Settings entry; it never polls. The server orders the candidates and owns the copy, so the client displays the first one and renders its message verbatim.

The notice is painted as soon as the server offers it, including underneath the translucent settings panel, once the document is visible and the card has passed one presented frame. That painted frame is the whole display signal: the card measures no cover, so a card behind the open overlay counts exactly as any other, and closing the card counts as a display too. Displaying a card queues its acknowledgement, so one mounted card is acknowledged once. A failed acknowledgement retries with a capped backoff for the rest of the signed-in session and never surfaces as an account UI error. A read that fails leaves the visible card and its pending acknowledgement alone, so a transport reconnect keeps retrying. Nothing is written to browser storage. The second signed-in frame of one sign-in and a reconnected stream's replayed state are one session, not a new one, so they keep the card and its retries; signing out, replacing the credential with another account's, or unloading the plugin discards them. Every signed-in frame reads again, and a newer read supersedes one still in flight, so a credential swapped in place is named by a fresh read rather than inheriting the replaced account's; the batch's account id then drops the previous account's card and queue even with no intervening signed-out state. The next sign-in displays whatever the server still offers, including an order an earlier sign-in acknowledged, and a card the user has already seen stays up until it is closed, even when a later read returns no bonus.

<a id="desktop-onboarding"></a>
### Desktop onboarding

The Desktop preload marker enables the introduction after account credentials are stored. Progress belongs to the local Host settings document, not the Platform account: unfinished steps resume after restart, and completing or skipping the flow prevents another run on that installation. Browser clients do not mount it. API-key presence comes from the native welcome backend through the boolean-only Desktop preload bridge, using the same credential discovery as login. A signed-out installation with a configured model API key bypasses the pages and applies standard process, detailed usage, and enabled Coding Tools.

The welcome page requires Get started. The credit page always appears. A positive balance confirmed at first entry selects Continue as the primary action and Add credits as the secondary action. This choice stays fixed until the onboarding controller is recreated and is never persisted; late balance results cannot change the buttons. Only a confirmed absence of positive credit adds a confirmation before continuing without recharge; pending or failed queries do not block continuing. Purpose descriptions remain unchanged when selected. Returning from the native top-up view keeps the credit page and re-reads profile and balance in the background after any read already running, whether loading or payment succeeded. That read does not recompute the funded-mode choice, so a completed recharge leaves the buttons as first entered while continuing still evaluates the refreshed balance. Next confirms only a known zero balance; Skip uses the credit warning on the credit page and the setup warning on the question pages. Office-only use completes with compact presentation; development or both purposes also ask for process detail. Back preserves selections, and explicit skip from any supported step applies standard process, compact performance/usage, and disabled Coding Tools. This flow creates no workspace or demonstration task.

<a id="understand-the-implementation"></a>
## Understand the implementation

The Account section appears first in Settings only while signed in; it is hidden before account state loads and after sign-out. The plugin owns one Host snapshot stream shared through framework hooks by settings.section and settings.launcher. The launcher opens Settings and offers Sign out only while an account credential is stored. Platform failures leave the menu available for retry. It maintains no independent credential state, so no invariant companion is published.

The desktop controller writes progress to `ui-settings-account` through Host settings. Completion first applies `ui-chat.transcriptView` and `ui-chat.performanceUsage` together, then calls the shared Coding Tools preference to persist `ui-settings.enabled`, and finally saves the done marker; a rejected write keeps the flow available for retry. Successful completion reveals the workspace through a 180ms fade; choices and ordinary navigation preview immediately while writes run in order. A failed final queued write restores saved progress and allows retry. Completion waits for queued choices and retains the page until preferences persist; reduced motion skips the fade. Onboarding choices compact, standard, and detailed apply directly to the corresponding Chat work-detail modes. API-key entry and explicit skip select standard; onboarding does not select verbose. Complete Figma illustration layers are bundled as transparent, palette-compressed 3× PNG assets; welcome layers are merged with local sidebar blur; recharge uses a 70% opaque foreground window with local blur of the covered illustration, and headings use the bundled Montserrat brand font; English headings and descriptions use Light (300), except the DeepSeek Harness brand within headings uses Medium (500); card titles retain Regular (400) when selected. English footer navigation uses Light (300). Confirmed onboarding sets a 960px minimum window width and enlarges narrower windows; completion releases the minimum without restoring the previous size. Loading or already-completed onboarding does not resize the window. Empty footer navigation space passes pointer events through to the primary action. Cards exclude native window dragging and own the keyboard focus outline for their checkbox. The account package owns its onboarding overlay and control geometry. Each step and the confirmation dialog has a separate component; the flow coordinates navigation, transitions, and recharge. The overlay hides the workspace while initial account and progress state loads. Question headings and cards follow the Figma positions at 1440 × 920 and 960 × 600, independently of their action buttons. On macOS, content clears the body portal’s inherited no-drag region and a first-child drag band leaves an 8px native resize margin; interactive controls and later dialogs exclude their regions, and a native Platform page disables the underlying onboarding band. The upper workspace popup illustration has an opaque background in both languages and themes; the underlying sidebar omits its selected-row highlight. Welcome keeps its illustration at its original size, repositions and clips the artwork in narrow windows, and reveals the complete illustration on wide windows. The [onboarding decision](../../../.agents/notes/implemented/feature/2026-09-16-desktop-onboarding.md) owns persistence and presentation trade-offs.

<a id="further-exploration"></a>
## Further Exploration

The [credentials subsystem](../../../docs/subsystems/credentials.md) owns storage APIs; the [architecture](../../../docs/architecture.md) explains application composition.

Account login uses a dismissible dialog before the model onboarding credential editor. The dialog uses a compact, right-aligned action row with the primary action last. The sidebar displays the profile name, falling back to the server-masked phone number or email when the name is absent; it stays blank while the profile is loading. Dialog copy and the sidebar account label are not text-selectable; the copy-link button remains available and restores its label two seconds after each successful copy. Clipboard failures show Copy failed on the link for two seconds without interrupting sign-in. Waiting shows a copyable authorization link and a loading indicator; timeout and failure require an explicit retry. The dialog's Copy sign-in link and the Settings Open link append the resolved Desktop palette as `theme=light` or `theme=dark` from the live theme snapshot, so both routes reach the Platform page in the current application theme without changing the theme preference Platform has saved. Sign-in failures render in that dialog; a failed sign-out keeps the menu open so the user can try again, and the launcher shows no failure of its own. Closing a waiting dialog cancels its Host attempt. The sidebar can reopen the same API-key editor through the settings coordinator.

A terminal account-state stream failure appears in the sign-in dialog or Account settings. Plugin unload suppresses late failure reports.

The balance card shows recharge funds and bonus credit in separate rows. The bonus row is present while signed in; without positive bonus credit it states that no bonus is available. A failed wallet read shows the existing unavailable copy as a link to Platform — the same destination and behavior as the Usage action, so the embedded page opens on Desktop and a new tab elsewhere — while the loading and empty states stay plain text. Currencies retain their own amounts, and a notice date is rendered only inside the server’s own message.


A successful login selects the first available `deepseek-account` model as the default when no other provider has a configured API key, even if a previous default was saved. Configured keys preserve the existing default even when their provider has no available models. Session-specific selections remain unchanged.

<a id="model-experience"></a>
## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Profile and recharge-wallet balances use the existing Platform Web endpoints through Host getProfile / getBalance. The page refreshes when opened and after login or reconnect, preserves server-masked contact data, and shows query failures independently without manufacturing a zero balance. Usage and top-up use Host-provided links derived from platformOrigin and the browser’s own login; the links never carry a DSH token.
- Completed installations do not reapply defaults or overwrite later user preferences. Completion does not synchronize across devices or create a per-account history.
- Onboarding follows the interface locale and theme, with four Figma PNG illustration sets covering Chinese and English in light and dark appearance. Export canvases include the full illustration geometry; Finder artwork uses the same vertical fade in both themes.

- The notice copy is server-localized for the UI language in effect when the client reads it. Switching language does not itself re-read the unnotified bonus, so a notice already on screen keeps the copy the server sent for the earlier language until the user refreshes or the account lifecycle restarts.

- The Platform view’s dialog marks every other document child inert, including the Desktop-owned caption menu host, so the Application and Edit menu stays visible but cannot be operated until the view closes. Exempting that host needs an inertness contract owned by the Desktop.

<a id="dev-note"></a>
### Dev Note

The [desktop login decision](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md) records cancellation and storage ownership.

Usage and top-up show a centered 24px loading indicator without visible loading text until the native document loads; the return action remains available. The loading SVG is embedded locally from Figma node 2957:72553.

Default-model initialization runs after publishing and accepting the sign-in frame, without delaying subsequent account frames. Failures are recorded in diagnostics and do not mark the signed-in account as failed.

Read-only onboarding settings and a failed initial account stream leave the workspace accessible. A failed initial settings read exposes Retry, which reissues the shared settings read. Overlapping onboarding and Platform overlays release background interaction only after their last owner unmounts.
