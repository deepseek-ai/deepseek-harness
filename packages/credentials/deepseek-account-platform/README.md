---
description: "Sign in through the system browser and keep the account credential in the existing local credential store. Local cancellation prevents late callbacks and exchange responses from signing the user in."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-account-platform

English | [中文](README.zh.md)

Every operation that reaches Platform takes the caller's `AccountClientMetadata`: the client version, the active UI language, and the UTC offset in seconds. The provider derives the five Platform client headers from that metadata and the composition's platform, so each request reports the UI that made it instead of the last caller the Host saw. A new sign-in attempt captures the metadata for its initialization, exchange, and cancellation, and a joining caller never replaces it; sign-out captures the metadata for the revocation retries that outlive the request.

getPlatformSession exports the stored grant only when its issuer matches platformOrigin. This Host-only operation supports native Platform embedding without widening the model/file origin configured for resolveToken. Its userId repeats the stable account ID from the most recent successful getProfile, and is null until one succeeds or when that profile carries no ID; the snapshot issues no profile request of its own, so a slow or failed profile request never delays it, and an unknown ID leaves userId null, which consumers treat as temporary-storage mode. A credential change during the grant read discards the snapshot.

`desktopPlatform` defaults to `null`, which sends `x-client-platform: web`; the Desktop profile supplies `darwin` or `win32`, becoming `desktop-mac` or `desktop-win`. The provider owns all five headers, so deployment configuration cannot override them; `x-client-bundle-id` is intentionally empty, and `x-client-locale` reduces the caller's language to `zh_CN` or `en_US`. PlatformSession carries deployment headers only, and the embedding client composes the same five headers for the Platform documents and API requests it opens, only at the configured origin.

Profile and balance HTTP 401 responses or top-level response code `40003` (invalid authorization) clear the rejected local grant and emit the live `deepseek-account/session-expired` notification. Concurrent responses share one removal; responses from an invalidated credential generation cannot clear its replacement. Other HTTP failures retain the grant. Host inference consumers can report a rejected request token through `rejectToken`; removal requires that it still matches the stored login.

## Summary

Sign in through the system browser and keep the account credential in the existing local credential store. Local cancellation prevents late callbacks and exchange responses from signing the user in.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The profile projection maps `id_profile.picture` to `avatarUrl`, using null when no picture is configured.

Token resolution refuses requests while local sign-out is in progress. Successful local removal publishes `deepseek-account/signed-out` before returning the signed-out snapshot; remote revocation remains independent.

getProfile / getBalance sends the stored grant in the x-dsh-auth-token header to GET /auth-api/v0/users/current and GET /api/v0/users/get_user_summary on platformOrigin. The grant issuer must match that origin. Host projects only the account UID, profile name, avatar URL, phone or email exactly as masked by Platform, and normal_wallets / bonus_wallets currency/balance strings; response tokens and other fields are discarded. A balance or bonus-amount string is accepted when it matches the numeric grammar Platform's Web client already passes to big.js, which allows an omitted integer or fraction part and a decimal exponent, so values such as 0E-16 and 5.0000000000000000 stay valid; the original string is retained and NaN, Infinity and malformed text are rejected. Bonus wallets remain separate from recharge balances. Credential changes and disposal invalidate in-flight queries.

getUnnotifiedBonuses reads GET /api/v0/users/get_unnotified_bonuses and ackBonusNotified posts POST /api/v0/users/ack_bonus_notified with a JSON body naming the order on the same origin, each sending the five client headers built from the caller's metadata. Both resolve the account identity for the captured grant first, so a signed-out or switched account yields null or false instead of acknowledging another account's bonus, and a read publishes only after the whole query settled under one credential lifetime. The Host forwards the bonus list in Platform order, maps each msg to message, and discards nothing else; malformed payloads, other HTTP failures and other business failures throw, while a credential rejection (HTTP 401 or response code `40003`) invalidates the current grant and yields null or false.

Balance requests use balanceTimeoutMs (30,000ms by default); timeout returns a failed outcome without clearing the account or manufacturing a zero balance. Configure platformOrigin, allowLoopbackHttp, requestTimeoutMs, balanceTimeoutMs, and attemptTimeoutMs in the plugin row. HTTP is accepted only for explicitly enabled loopback development. The provider registers /oauth/callback on the existing Host webServer before auth_init, validates state, exchanges an S256 PKCE code once, and commits a grant before redirecting to auth_exchange.biz_data.authorized_url. Browser destinations default to the configured platform origin and always require the fixed /dsh/authorize or /dsh/authorized path. The completion URL sets `login_source` to the initiating client (`web` or `desktop`) and preserves other Platform-supplied query parameters. Device identity is a separate random UUID record shared by processes using the same credential store; device_model reports OS and architecture.

Platform URLs have one configuration owner: `platformOrigin`. Authorization requests, browser validation, completion redirects, usage, and top-up destinations all use that origin. Set it in a private `$DSH_HOME/cordis.patch.yml`; deployment addresses do not belong in source control. HTTPS is required except for loopback HTTP with `allowLoopbackHttp: true`. Model and file token destinations use the separate `inferenceOrigin` configuration.

`requestHeaders` adds Host-only headers to authorization, profile, balance, and logout requests on `platformOrigin`. Header values are secret configuration; they are excluded from account UI state. Authorization, X-DSH-Auth-Token, Host, Content-Type and connection/framing headers are reserved. Client identity headers override same-named deployment headers. Redirects fail without forwarding headers. Store deployment cookies in private configuration or environment variables; browser cookies are not collected automatically.

A private patch can read environment variables through Cordis expressions:

```yaml
- id: deepseek-account
  config:
    platformOrigin: !!js process.env.DSH_PLATFORM_ORIGIN
    allowLoopbackHttp: !!js process.env.DSH_PLATFORM_ALLOW_LOOPBACK_HTTP === '1'
    requestHeaders: !!js |
      process.env.DSH_PLATFORM_COOKIE ? { Cookie: process.env.DSH_PLATFORM_COOKIE } : {}
```

The authenticated client supplies its browser-accessible callback origin, including the local SSH forwarding port, and its UI kind. The provider fixes the callback path and binds the resulting redirect_uri to both initialization and exchange. Callback requests use state and PKCE validation rather than RPC authentication. Completion, cancellation and disposal remove only the attempt route. Exchange failures publish failed state without retrying: Web closes its authorization tab and keeps the failure dialog in the original tab; the callback page attempts to close itself and offers a manual-close message. Desktop receives HTTP 204 and focuses its existing login UI through the account stream.

Host diagnostics use the `[deepseek-account]` prefix on standard output and in the Host inspector Console. They include endpoint paths, HTTP status, numeric response codes, failure stages, invalid field paths, received types and validation codes, and browser URL rejection rules; headers, request and response bodies, authorization URLs, and raw exceptions are excluded.

`rewriteBrowserOrigin` defaults to `false`, requiring same-origin browser URLs. A private development patch may set it to `true` to map authorization and completion URLs to `platformOrigin`, preserving their fixed paths and query strings. Source URLs must use HTTPS or already match the configured origin; user information, fragments and unexpected paths remain rejected. Shipped profiles retain strict same-origin validation.

inferenceOrigin defaults to `https://api.deepseek.com`. A private deployment patch may replace it with one exact HTTP(S) origin, including its port, for inference and file authentication through x-dsh-auth-token. Paths, URL credentials, queries and fragments are invalid configuration. Alternate origins require a grant issued by the configured platformOrigin; mock tokens remain excluded. Loopback grants cannot authenticate the official production API. Deployment addresses belong in private patches, not shipped configuration.

At provider initialization, a valid stored grant whose issuer differs from platformOrigin is deleted locally before consumers read account state. Startup continues signed out without a remote logout request; API keys and device identity remain stored. Storage failures remain explicit, and account HTTP or response-validation failures do not delete a matching grant.

<a id="understand-the-implementation"></a>
## Understand the implementation

No runtime invariant companion is published: account presence reads the credential store, and attempt state projects private state directly. There is no independently maintained account index to compare. Behavior tests verify asynchronous cancellation and commit ordering.

<a id="further-exploration"></a>
## Further Exploration

The [credentials subsystem](../../../docs/subsystems/credentials.md) owns storage APIs; the [architecture](../../../docs/architecture.md) explains application composition.

The attemptTimeoutMs limit includes initialization, browser waiting, and exchange. Initialization does not extend its absolute deadline; the server TTL may only shorten the remaining time. Credential persistence admitted before expiry completes without cancellation.

<a id="model-experience"></a>
## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser sign-in requires the Host webServer. Only local access and SSH local forwarding through HTTP localhost, 127.0.0.1, or [::1] with an explicit port are supported; non-loopback reverse proxies are unsupported. Account tokens have no expiry or refresh flow; explicit DSH sign-out removes the local grant before calling POST /auth-api/v0/users/logout in the background. Remote failures never restore local login. The captured old token receives at most five additional attempts with exponential delays of 1, 2, 4, 8, and 16 seconds by default; logoutMaxRetries (0–5) and logoutRetryDelayMs configure that policy. Each request uses requestTimeoutMs. Provider shutdown aborts requests and waits, and pending revocations are not persisted. Local credential deletion failures remain visible to the caller. Authorization-attempt deadlines still apply before a token is issued. Cancellation or timeout after initialization sends one background POST /auth-api/v0/dsh/auth_cancel with the authorize_id from auth_init.biz_data and the original code_verifier, without account authorization. Local cancellation never waits for this request or reverses on failure; requestTimeoutMs bounds it, and provider shutdown aborts it. TODO(product-error-ui): Product must define localized copy and UI behavior for the supplied biz_code values. Until then, business failures use the existing generic retry message; other codes and HTTP errors use the same fallback. Development grants never authenticate production requests.

<a id="dev-note"></a>
### Dev Note

The [desktop login decision](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md) records cancellation and storage ownership.

The first profile read after sign-in uses the sanitized user returned by auth_exchange. A null or malformed user falls back to current; subsequent refreshes and Host restarts also query current. Failed current requests retain the latest successful profile for the same credential in Host memory; credential changes and disposal clear it. A ready current response whose stable account ID first becomes available or changes notifies watch subscribers, so identity consumers re-read getPlatformSession; refreshes that repeat the same ID stay silent. Exchange registers the submitted device information.

accountRequestHeaders overlays requestHeaders for current, balance and embedded Platform page/API requests. Cookie pairs merge by name so routing overrides retain other deployment cookies. Authorization initialization, exchange, cancellation and logout keep requestHeaders. Both maps remain private to Host and Electron main; the session's userId stays Host-only too, and renderer bootstrap receives only origin and token.

The account provider’s `embeddedPageDist` configuration adds a `dist` query parameter to embedded Usage and Top-up URLs. Its default is empty; private frontend branch selectors belong in the local profile patch. It does not change API URLs or credential delivery.

Platform wallet balances accept decimal strings with optional scientific notation (including `0E-16`); the provider preserves the original string for consumers.
