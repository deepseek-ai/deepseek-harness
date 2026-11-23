---
description: "QR login, private login links, and owner-approved browser pairing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-connection

English | [中文](README.zh.md)

## Summary

Settings shows shared sign-in guidance, then access-address and QR login cards. A signed-in owner can generate a one-use QR code or copy a tokenized URL to sign another browser into the same Host. QR redemption issues a Remote browser cookie; credential links use independent Token login. Without a credential link, copying uses the clean address. Credential warnings follow QR generation or successful copying of credentials. The login link displays its token and fades at the right edge. Clipboard outcomes use a shell toast that survives closing settings.

## Table of Contents

- [Use this package](#use-this-package)
- [Authentication and failures](#authentication-and-failures)
- [Pairing requests](#pairing-requests)
- [Add settings options](#add-settings-options)
- [Replace the settings panel](#replace-the-settings-panel)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The Web bundle mounts this plugin. Its Host half requires `connection`, `connection.authentication`, `credentials`, `webServer`, and `webApp`; its Client half contributes the panel to browser settings through `settings.section`. The Desktop window omits this section. Removing the plugin removes its page, endpoints, outstanding invitation, and Remote Peer. Already-issued Remote cookies require this provider to be active; valid cookies can be used again after the plugin reloads with the same credential record. The settings panel supports all eight shipped UI languages; the anonymous login page supports English and Chinese. Both cards enclose their titles. The section heading and introductory text match the Models settings typography and spacing. QR actions share the title row on wide cards and stack at full width below the title on narrow cards. The panel uses standard small buttons. The URL field matches the copy button’s 28px height and centers the address text vertically. On narrow cards, the copy button spans the card’s content width below the URL field. The copy button keeps its label and disables only during a clipboard write. The expiry banner sits below the QR header and spans the card's content width. The countdown is centered below the QR code, with an additional 16px bottom margin before the credential warning. Regenerating a visible code replaces only the QR image with a spinner; the countdown, warning, and link controls stay in place. Cancelling closes the preview and restores **Create QR code** without a success message.

QR login uses the advertised application URL, which supports HTTP and HTTPS, must name a non-loopback address reachable by the phone, and must pass Connection's trusted-host checks. Configure the listener, optional certificate or reverse proxy, `publicUrl`, and trusted hosts through the existing [Web application](../../bundle/web-app/README.md) configuration. This plugin never changes the listening interface or discovers a network address. A reverse proxy must preserve the external Host, remove its configured path prefix, and protect its upstream connection. A plain HTTP listener issuing a cookie for an HTTP public URL omits `Secure`; HTTPS listeners and HTTPS public URLs behind a TLS-terminating proxy retain `Secure`. An HTTPS proxy must enforce HTTPS for its public origin. The settings panel allows HTTP login and reminds the user that HTTP transmits login credentials without encryption.

The panel shows unmet address prerequisites in a shared notice above the cards. For a trusted loopback address such as `127.0.0.1`, the access-address card shows the Token login link when the provider supplies one. The owner can copy it to sign in with another browser on the same computer. QR login stays hidden because other devices cannot reach this address. Wildcard and untrusted addresses show only the clean URL. Pairing approvals remain available. Deployment-read failures remain retryable in the address card while QR login is unavailable. Reconnecting checks the address prerequisites again.

`cookieMaxAgeDays` defaults to 30 and fixes each Remote cookie's absolute lifetime. `ticketLifetimeMs` defaults to 120000. `pollIntervalMs` defaults to 1000 and controls the settings panel's status checks while its code is displayed. Only one invitation is outstanding per plugin instance: generating another replaces the previous one, and cancelling an old invitation does not cancel its replacement.

## Authentication and failures

The QR uses the advertised application root with `?login=qr` and an independently generated 256-bit credential in the URL fragment, never the process launch token. The root login page removes the fragment and exchanges it with a same-origin POST to `?login=qr`. GET and HEAD do not redeem it. Remote applies WebServer’s anonymous source checks before reading the exchange, checks the advertised authority, consumes the credential once, and signs its own owner browser cookie. Redeemed, expired, cancelled, replaced, and pre-restart invitations cannot be exchanged again.

Only an authenticated owner can create, inspect, or cancel invitations. The Host retains a digest of the credential, not its reusable plaintext. The public page has no authenticated application injections and sends no credential to third parties. Failed QR exchanges keep the ordinary login page and its configured Token form available, with a localized banner explaining the failure. An interrupted exchange may already have issued the cookie; the banner offers a clean application link to check an unconfirmed result and never retries the one-use credential automatically.

The owner-only `loginUrl()` method reads the same WebServer instance’s Token entry published through `webserver/entry-url` and returns the advertised root with its process launch token in `?token=…`. A Host without Token authentication cannot provide this link; QR login remains available. Unlike the QR invitation, this link remains reusable until the Host process restarts. Copying it never creates, consumes, or replaces a QR invitation. The Client prefetches the URL only after the Host allows Token login links for the advertised address, retains it in plugin memory, displays it with a fading right edge, and refreshes it on reconnection. Starting a credential read clears earlier copy notices. The credential warning resets when the URL changes or the user leaves Remote connection settings, including by closing the panel. A clipboard write that finishes after leaving still reports its outcome through the shell toast, but cannot restore the warning for a later visit. While the credential URL is loading or unavailable, copying uses the displayed clean address without a link-read error or Retry button; QR creation remains independent. Only a successful copy of the current credential URL enables its warning; copying the clean address does not. A refused clipboard write reports failure and leaves copying retryable. Neither link reads nor copy outcomes are persisted or logged.

Remote owns the persistent `client-remote-connection/browser-session` credential record. Its signing key and v1 cookie format are independent of Token; a cookie binds the listener protocol and normalized Host, carries fixed issue and expiry times, and uses `HttpOnly`, `SameSite=Strict`, and `Path=/`. Validation never renews it. Corrupt records fail activation rather than replacing the key. Preserve the record across restarts to retain valid logins; replacing or deleting it invalidates old cookies on the next activation.

Remote uses one root login document for ordinary sign-in and QR exchange. A trusted but unauthenticated visit to the ordinary root receives HTTP 401; HEAD retains 401 without a body. The `login=qr` mode returns the same ordinary login document with HTTP 200 even when the browser already has a login cookie; it attempts QR exchange while retaining the page’s sign-in controls. The document exposes no Token value or private application injections; the Token form appears whenever Token publishes an entry. The Token field accepts either a token or a full login link, and its placeholder uses the current page’s protocol, address, port, and application path with `xxx` as the example token and the theme’s caption color. Existing query parameters and fragments are omitted. Initial HTML uses a generic address template until the page initializes. Its hint directs users to copy a link from Settings → Remote connection on a signed-in device and paste it into this page. The page uses the application’s default font stack and grayscale text rendering. The Token field uses the theme’s blue focus border, with validation errors taking priority. Authenticated visits without QR mode render the application with their actual Peer and no second credential check. Source rejection remains 403; authentication failure without another successful provider remains 503.

## Pairing requests

The anonymous root page places Token entry and device pairing in separate cards below a shared heading. Its introduction asks users to choose one of the available sign-in methods. Both cards place a heading and description before their controls and use matching typography and spacing. Token errors appear below the field while the sign-in guidance stays visible. QR exchange feedback appears above both cards; a failed exchange leaves both sign-in methods available. Its deferred public `pairing/client.js` script defines `dsh-device-pairing`; the element owns the request controls, styles, and translations without loading authenticated Client modules. The Host generates this script from self-contained browser functions and public data shipped in its ordinary entry; plugin reload replaces the script with the current implementation. Removing the element aborts its work and discards its private ticket; browser back/forward-cache suspension preserves the ticket and resumes status checks.

The anonymous pairing card places the code, Request again, Cancel request, and waiting status in order, with the countdown beside the status. Request and status-check failures appear in full-width error banners; denial and expiry use warning banners. These banners have no icons; their border, spacing, and radius match the banners in Remote connection settings. The countdown stays outside these banners. Network and server failures show automatic reconnection status. HTTP 429 responses show an automatic retry notice; exhausted rate-limit retries ask the user to wait before requesting again. Exhausted recovery shows an error banner with Request again and no separate status-query action. The request action retains its primary foreground color while disabled. Confirmed cancellation restores Request to pair without a cancellation notice.

Settings shows pairing requests in a separate card after the access address and QR login cards, even when the advertised QR address is unavailable. The full-access warning banner appears only while the card displays requests. If a list read fails, the card hides the requests and warning and shows an error with **Retry**. A successful retry displays the latest list. A browser signed in through pairing has owner access and can approve requests from other devices. Pairing, QR, and link login keep independent state: creating or cancelling a pairing request does not replace a QR invitation or the reusable login link.

The public POST routes `pairing/request`, `pairing/status`, and `pairing/cancel` declare anonymous authentication; WebServer applies the Host, Origin, and Fetch Metadata checks before invoking their handlers. URLs resolve relative to the application directory for reverse-proxy mounts. The browser generates an ID and random secret before sending the first creation request. All three routes accept exactly these two JSON fields. Repeated creation with the same ID, secret, and origin returns the retained ticket without extending its expiry or changing its decision, including after cancellation. The Host generates a separate display code and retains the original connection IP. Only the applicant holds the secret; the display code cannot query, cancel, or collect the request. Settings uses `remoteConnection/pairingRequests` and `remoteConnection/decidePairing`; both require an active owner invocation, including when an API peer has method grants.

Approval rows display `sourceIp`, captured from the creating connection and normalized for IPv4/IPv6; missing addresses display Unknown. Forwarded headers are ignored. Behind a proxy this is the proxy's IP. `authority` remains the application's origin binding, never the displayed source; an IP does not identify a device or authorize access.

The first approval or denial wins. Cancellation can withdraw an uncollected approval. Approval lets the applicant collect a Remote cookie through the same private issuer used for QR redemption, independently of Token authentication. Retrying a lost response before request expiry returns the same cookie without extending its lifetime. Denial, cancellation, expiry, and plugin shutdown cannot create a login.

When an owner decision returns `approved`, `denied`, or `unavailable`, the card removes the request from the visible list before displaying the outcome notice. Earlier in-flight reads cannot restore the row, and the card immediately requests fresh data, including after a list read failure. An unknown decision outcome leaves the request in the list until a later read confirms its state. Changes from other devices and request expiry appear through the regular polling interval.

The applicant can cancel while creating a request or waiting for approval. If the creation response is unknown, the browser first repeats creation with its retained credentials to recover the same ticket, then confirms cancellation. An unknown cancellation retains those credentials; it cannot start another request.

The waiting page shows the remaining time. Creation, status reads, cancellation, and authorization checks have a complete-response timeout. Network failures, unreadable responses, HTTP 429, and server failures retry automatically with exponential delays starting at `pollIntervalMs`, capped by `retryMaxDelayMs`, for at most `maxRetries` additional attempts. A successful status read resets this budget. Other HTTP refusals stop immediately. Exhaustion stops automatic work and shows an error banner. **Request again** confirms that the previous request ended before creating new credentials and a new pairing code; an unconfirmed cancellation never creates a replacement. In-flight work is aborted and its late result cannot overwrite a replacement. After denial, cancellation, or confirmed expiry, the same action creates a fresh request.

At local or Host-reported expiry, the page aborts pending pairing work and checks browser authentication with a no-store `HEAD` request to the clean application URL. `200` opens the application; after `401`, the browser also confirms cancellation of the old request, whose Host expiry can be later than the local deadline. Only then can it finish expiry or create a replacement. Failed checks use the same bounded recovery. Exhaustion retains the credentials and reports an unknown sign-in outcome; **Request again** repeats this check before it can create another request. Only a confirmed signed-out browser can start again; cancelling a fetch does not undo a cookie already received.

Configure request limits under this plugin's `pairing` field:

| Field | Default | Meaning |
|---|---:|---|
| `pairing.requestTtlMs` | 300000 | Request lifetime, including approved delivery retries; must exceed the polling interval |
| `pairing.maxRequests` | 32 | Maximum retained pending and terminal requests |
| `pairing.requestIntervalMs` | 1000 | Minimum interval between creations across applicants |
| `pairing.pollIntervalMs` | 2000 | Minimum applicant polling interval, initial retry delay, and cadence for periodic Settings refreshes |
| `pairing.requestTimeoutMs` | 10000 | Timeout per HTTP attempt, including response-body reading |
| `pairing.maxRetries` | 3 | Additional attempts after transient failures |
| `pairing.retryMaxDelayMs` | 10000 | Maximum exponential retry delay; must be at least the polling interval |

Requests are process-local and remain in the bounded pool until expiry, including after a decision. Restarting or unloading the plugin clears them without revoking issued cookies. A full pool or creation rate limit asks the applicant to retry later; a failed poll retains the private ticket for recovery.

## Add settings options

Register in the root-scoped list `settings.remoteConnection.extensions` to add options after the main panel, including its default access-address, QR login, and pairing cards. Each plugin uses a unique `id`; entries render in ascending `order`, then registration order. Extensions appear alongside either the default panel or a replacement. `RemoteConnectionExtensionProps` provides the same shared state hooks, actions, and `close()` as [panel replacements](#replace-the-settings-panel). Each extension owns its rendering and localized copy.

```ts client
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FunctionComponent } from 'react'
import type { RemoteConnectionExtensionProps } from '@deepseek-ai/dsh-client-remote-connection/client'

declare const ConnectionOptions: FunctionComponent<RemoteConnectionExtensionProps>

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.remoteConnection.extensions', () => ctx.slots.register({
    name: 'settings.remoteConnection.extensions',
    id: 'example.connection-options',
    order: 100,
  }, ConnectionOptions))
}
```

## Replace the settings panel

The root-scoped, single `settings.remoteConnection.content` slot replaces the main panel, including the default access-address, QR login, and pairing cards, while retaining its one settings navigation entry and additive extensions. Every occupant receives `RemoteConnectionContentProps` from this package's `/client` type exports: `useRemoteConnection(selector)`, `create()`, `cancel()`, `reload()`, `useLoginLink(selector)`, `copyLink()`, `reloadLink()`, `dismissCopyNotice(sequence)`, and the settings shell's `close()`. Both slot prop types include `useApproval(selector)`, `decide(id, decision)`, and `dismiss()`; render approval controls only while `available` is true. The plugin owns invitation, link, and pairing approval state across replacements, so switching views preserves the current invitation, countdown, and copy feedback. Actions report their outcomes through the state hooks. A replacement owns its rendering and localized copy; it may register its own `locale` namespace.

Register a replacement component from your Client plugin with a lower priority than the default panel's `0`:

```ts client
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FunctionComponent } from 'react'
import type { RemoteConnectionContentProps } from '@deepseek-ai/dsh-client-remote-connection/client'

declare const CustomPanel: FunctionComponent<RemoteConnectionContentProps>

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.remoteConnection.content', () => ctx.slots.register({
    name: 'settings.remoteConnection.content',
    priority: -1,
  }, CustomPanel))
}
```

`slots.inject` supports loading either contribution before the Remote connection plugin and re-registers it when the slot owner returns. Unloading an extension removes only that contribution, preserving the main panel, other extensions, and shared state. Unloading a replacement restores the default panel and its current state; unloading the Remote connection plugin removes both slots, stops polling, discards the link credential and copy notice immediately, and waits for outstanding reads, clipboard writes, and queued refreshes to settle. Only display `ticket.url` as a QR while `phase === 'pending'`: an uncertain operation may retain the ticket for recovery without permitting its display. Never persist or log either credential URL. Replacing this panel does not replace the anonymous login page or any Host login method.

## Further Exploration

- [Web server subsystem](../../../docs/subsystems/web-server.md) — browser services and settings contributions.
- [Connection](../connection/README.md) — request-source policy, provider registration, and Peer ownership.

## Model Experience

None, as this package provides browser authentication and contributes no model input.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

- Before redemption, anyone with the QR can redeem it first. Expiry and single use limit exposure; they do not prevent credential forwarding or phishing. A previewer that executes JavaScript may consume the code.
- Login belongs to the browser that completes the exchange. A scanner's embedded browser and an installed PWA may use different cookie stores. Clearing cookies, changing the Host authority, or cookie expiry requires signing in again.
- The resulting browser has owner access. Remote cookies share one runtime Peer, with no per-device permission or revocation list. Cancelling a QR does not revoke an issued cookie. Cookie expiry rejects new requests and connections; it does not terminate an already-admitted WebSocket. Unloading Remote closes its shared Peer and connections, independently of Token connections.
- The Host must remain running and reachable after the original browser closes. This plugin supplies neither tunnelling nor remote wake-up.

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
