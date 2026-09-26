# Agent Note: Account quota top-up action

Status: implemented

English | [中文](2026-09-18-account-quota-top-up.zh.md)

## Problem

A provider quota failure can mean an exhausted first-party account balance, an API-key account problem, or a custom gateway response. All require a useful explanation, but only the first case can be repaired by opening the signed-in user's embedded DeepSeek recharge page. Inferring that case from provider prose or current UI configuration would make historical failures unstable and could expose an irrelevant billing action.

## Decision

The `llm-deepseek-account` plugin classifies quota failures for its own route. The credential callback it hands the shared Messages transport releases the account token only for the configured inference origin, and the plugin rewrites the provider-neutral `QUOTA` failure to `ACCOUNT_QUOTA` for both HTTP 402 responses and in-band SSE errors. The API-key plugin registers `deepseek-official` independently and keeps `QUOTA`; neither route borrows the other's credentials, and a separately configured API key does not affect account-route quota actions.

A quota failure reaches the transcript and the frame-wide notice as two separate facts. The durable terminal-error record keeps the request-time code and always renders the same provider-neutral quota copy, so the Chat transcript, history paging, and the Session log do not depend on current credentials. A newly appended `QUOTA` or `ACCOUNT_QUOTA` failure in a Session this Client has bound and materialized also publishes one frame-wide notice; the newest notice replaces the previous one, and history replacement, pagination, and Sessions the Client never opened publish none.

Chat owns the notice host and registers it into the frame-wide `shell.overlay` slot, so a notice outlives the Chat panel that reported it. The host offers the one live notice, with `code`, `message`, `dismiss`, and `keepOpen`, to its `shell.quota-notice` chain child, and renders a generic warning Toast when no entry claims the code. The account package claims `ACCOUNT_QUOTA` only, showing a Cancel/Top up Modal; without the shared host entry, or with a snapshot that reports no stored credential or a failed account stream, the entry renders the neutral Toast itself, and with that host entry it waits for the first account snapshot instead of rendering a Toast that its own timer could discard. The plugin keeps one shared `PlatformPages` request channel and one `shell.overlay` host entry for the Desktop host's single native view: the Account settings page, the quota notice, and the Desktop onboarding recharge page request a page there instead of mounting their own container, the latest request retires the previous owner before the newer page shows, the shared host only closes the page it is given, and each owner decides what its own return re-reads: returning from a top-up page on the Account settings page or the quota notice re-reads profile, balance, and unnotified bonus, while the onboarding recharge return re-reads profile and balance only. Superseding a page, releasing a request, plugin unload, and leaving usage read nothing, and a release arriving after a newer request or a dismissal clears nothing. Back restores focus before any deferred Modal takes it. While a page requested through that shared channel is showing, the native view covers the document, so the entry renders neither Modal nor Toast. A quota failure that arrives while a Settings-opened page is already showing is not retained: it stays subject to newest-notice replacement, and the Modal appears after the viewer returns while that notice is still current. That Modal reports the failure of the original request rather than the account's current balance: the top-up re-read is a separate read, and returning neither proves a successful payment nor dismisses the notice by itself. The notice's own Top up is the retained case: it retains the notice with `keepOpen` and requests the `top-up` page; `keepOpen` returns an identity-safe release, and the entry releases both the hold and its page request when it unmounts, so a claim cannot outlive the entry that took it. Opening the top-up page therefore keeps the notice and the page mounted through later quota failures, which are dropped rather than queued while their persistent failure rows still render. Dismissal or sign-out releases the hold and the page request, so the next live quota event publishes again. Chat's subscription to a Session binding's live events ends with that binding or with the plugin, whichever goes first.

Credentials and billing URLs never enter Chat props or the Session log. Dismissing the notice does not retry the request; signing out closes an open account Modal or embedded page.

## Alternatives considered

**Derive eligibility entirely in the renderer.** Current endpoint, key, and login state may differ from the facts of a historical failed request. It would also couple Chat to credentials and provider configuration rather than keeping only a stable code at the presentation boundary.

**Parse the provider error message in the UI.** Provider prose is not a stable contract, cannot distinguish API-key and account-token billing, and would duplicate adapter error classification.

**Offer recharge for every quota failure.** This would send API-key and custom-gateway users to unrelated first-party billing. The generic notice remains useful without claiming a repair path.

**Infer billing from global credentials.** A configured API key may belong to another account and may be unused by the failed request. The explicit provider route owns credential selection and quota classification.

## Consequences

The Session log distinguishes account balance failure from generic quota exhaustion while the transcript renders both with the same neutral copy. One notice serves the whole app, so it stays visible after the reporting Chat panel closes, and a newer notice supersedes an older one instead of stacking. Because the account package claims the notice through a chain child, Web and signed-out users see the neutral Toast and no billing affordance, and the account package never imports Chat. A notice retained by Top up keeps that entry's page mounted through later quota failures at the cost of dropping those notices; the persistent failure rows remain their record. One shared request channel serves both the Account settings page and the notice, so a newer request replaces the visible page while identity-checked releases keep a superseded owner from closing it.

Provider tests cover routing with simultaneous credentials, HTTP 402 classification, and in-band SSE errors; presentation tests cover append-only publication, replacement, dismissal, Toast fallback, and embedded top-up navigation.
