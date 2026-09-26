# Agent Note: DeepSeek account browser login

Status: implemented

English | [中文](2026-09-14-deepseek-account-login.zh.md)

Sign-in captures the initiating UI's client metadata per attempt so browser authorization follows the Desktop or Settings language without depending on the Platform default.

## Problem

Desktop login must preserve local cancellation across the browser, UI, and Host and report success only after credentials are saved.

## Decision

The account Service Definition separates UI and model consumers from the platform protocol implementation. The platform provider registers an AuthorizationFlow and persists an owner-scoped GrantRecord. Account presence is derived from storage. Login attempts stay in memory and expose safe snapshots through the account Remote controller.

Local cancellation is authoritative. The provider stops callbacks and ignores late exchange results; auth_cancel invalidates the remote application and unexchanged code using authorize_id and the original PKCE verifier. Its background request does not delay local cancellation, and failure never restores login. session.commit admits persistence synchronously before its first await and rejects an already-cancelled flow. Cancellation after admission waits for the commit result. The callback redirects to auth_exchange.biz_data.authorized_url only after authorization settlement confirms storage.

Authorization registers a temporary /oauth/callback route on the Host webServer. The authenticated initiating client supplies its browser-accessible loopback HTTP origin, including any local SSH forwarding port. Non-loopback reverse proxies are unsupported. Cleanup removes only the route and preserves shared connections. Exchange failure returns Web to its login UI or focuses Desktop through account state; retry is explicit. PKCE secrets never cross UI transports. Model and file request tokens resolve only for the configured inferenceOrigin, defaulting to `https://api.deepseek.com`; redirects are refused. An explicit alternate origin requires grants from the configured Platform issuer, so changing the endpoint alone never forwards account credentials. Development loopback grants cannot authenticate production requests. API-key references remain separately stored.

Platform navigation and authorization share one validated platformOrigin from Cordis configuration. Private profile patches or environment expressions supply deployment-specific origins without committing development addresses.

Platform client identity belongs to the calling UI rather than to the Host. Every account operation carries the caller's client version, active language, and current UTC offset, and the provider derives the five Platform client headers for that call from them plus the composed native platform. Client identity headers override same-named deployment headers, so one Host shared by several callers reports the UI that made each request instead of the last one it saw, and the update-policy client keeps the same header meanings for the installed shell. PlatformSession deliberately omits caller identity; the embedding client composes its own five headers and limits them to the configured origin.

## Alternatives considered

Putting the protocol in Electron duplicates the implementation for Web consumers and gives the shell credential ownership. Putting tokens in DEEPSEEK_API_KEY loses the distinction between account grants and user API keys. Treating a browser callback as success before persistence admits false success. Waiting for a remote cancel acknowledgment leaves local cancellation dependent on network availability. Remembering one client identity in the Host would mislabel every other caller that shares it or reaches it through a forward. These alternatives are rejected.

## Consequences

Sign out removes the local grant before starting Platform POST /auth-api/v0/users/logout with the captured token. Remote failure never restores login. The provider retries at most five times after the initial request, with configurable exponential backoff starting at one second by default. Retry jobs retain only their old token, cannot change later login state, and end at provider shutdown without durable storage. Local credential deletion must succeed before publishing signed-out state. Sign out belongs to the sidebar account menu; Account settings owns profile, balance and sign-in. Both read one plugin-owned Host stream through framework hooks.

API keys and account grants remain separately stored. Account tokens have no proactive refresh flow; exhausted logout retries can leave the removed token valid remotely. Provider initialization discards grants from a different configured Platform issuer locally, without remote revocation, so switching environments starts signed out instead of aborting Desktop startup. API keys and device identity survive this cleanup. Profile and balance HTTP 401 responses clear the rejected credential; other query failures preserve login state; authorization-attempt deadlines apply only before token issuance. The same grant authenticates Platform current and get_user_summary queries on its configured issuer origin. Host preserves Platform-masked contact details and drops response tokens; account changes invalidate pending results. UI shows normal_wallets recharge balances and positive bonus_wallets in separate rows, so promotional credit is never presented as recharge funds.

The account plugin supplies choice, waiting, failure and timeout dialogs through settings.models.sign-in. The model package owns credential readiness and the existing API-key editor; the settings shell coordinates explicit reopening so login and API-key onboarding do not mount competing dialogs.

Platform embedding transfers a grant from Host to Electron over private Node IPC and then once to the trusted Platform main frame through a sandboxed preload. Preload performs one synchronous IPC before page scripts execute; the main process only validates the sender and returns prepared memory. Platform reads the token synchronously thereafter without a readiness API. A failed initialization retains embedded mode and a throwing getter. Account UI projections remain credential-free. The Platform document can read this credential, so its script security is part of account protection; context isolation protects native capabilities, not a token intentionally returned to the document. Replacing or removing the grant destroys the document and clears browser authentication; [account-scoped page storage](2026-09-22-platform-browser-storage.md) survives.

Support questionnaires receive only available environment metadata through explicit prefill fields. Account UIDs, tokens and masked contact details stay out of questionnaire URLs.

Private proxy development can explicitly map authorization and completion URLs to platformOrigin with rewriteBrowserOrigin. Both pages retain their fixed paths and full query strings; allowing a remote origin without mapping it would send the browser outside the configured environment. Shipped configuration requires same-origin URLs.

DSH grants authenticate Platform, inference and Files requests with x-dsh-auth-token, without a Bearer prefix. API-key authentication remains protocol-specific.

Profile and recharge-wallet queries use independent getProfile and getBalance operations. The client publishes each result as it arrives, so a slow or failed balance request cannot delay the sidebar username. Account changes invalidate both pending results.

Deployment authentication uses explicit Host-only requestHeaders on the configured Platform origin. The provider rejects redirects and reserved-header overrides so deployment cookies cannot replace account authorization or follow a browser destination. Environment-specific authentication protocols remain outside the account provider.

The bundled account UI is Desktop-only: its preload bridge enables the account launcher, settings and sign-in onboarding. Plain Web retains API-key onboarding and the standard Settings launcher without account subscription or login. The Host protocol accepts login_source (desktop or web) in auth_init; the bundled UI sends desktop. The backend accepts localhost callbacks. DSH preserves the browser-supplied localhost hostname and port without DNS resolution or conversion to an IP literal.

The macOS development launcher registers an isolated, ad-hoc-signed application bundle for `dsh://open`. The bundle retains the workspace entry and development paths for Launch Services cold starts without copying credentials or changing the package-manager-owned Electron application. Protocol registration targets the latest launched development or packaged application.

Exchange user data supplies the first profile read after credential commit, avoiding a second request before displaying the username. The Host retains only projected UI fields in the active attempt, matched to its token and consumed once; later reads use current. Missing or malformed user data does not discard successful authorization.

The embedded Platform document stays hidden during loading because native child views cover renderer overlays. Only the current document may become visible after loading; returning or signing out invalidates pending visibility changes. Native ownership also ends when the application document reloads or is replaced, its renderer terminates, or its window closes. React effect cleanup alone is insufficient because document teardown may never execute it. Same-document and subframe navigation preserve the view.

Separate accountRequestHeaders route account data and embedded Platform traffic independently of authorization and logout. Cookie overrides merge by name, retaining deployment authentication. Host passes the resolved headers over private process IPC; Electron injects them only at the configured origin and omits them from bootstrap.

Bonus notices use Platform-provided text and order identities. Reads occur when an account becomes active — signed-in startup and successful sign-in — and once per Settings entry or return from the top-up view, with no periodic polling. The card is painted as soon as the server offers it, including underneath the open Settings panel, so display is never deferred. The client acknowledges an order after a presented frame or the user closes it; nothing is written to browser storage, so a later sign-in re-displays an order the server still offers. Failed acknowledgments retry with capped exponential backoff for the rest of the signed-in session. Platform acknowledgments suppress delivery on other devices, but concurrent displays before acknowledgment are possible because the API does not reserve delivery. Fetch success alone never records a display.

The Host binds private Platform sessions to the account provider lifetime. Removal or watch termination clears Electron’s session; replacement subscribes to the new provider, and disposed reads cannot publish old credentials.

The client distinguishes plugin disposal from terminal account-stream failure. RemoteStream aborts its signal after either outcome, so the plugin owns a separate disposal flag to preserve failure feedback while suppressing reports after unload.

## Verification

Provider tests exercise real loopback callbacks, invalid state, delayed exchange cancellation, credential persistence, sign-out, and official-origin restrictions. Desktop tests cover the native action bridge and localized entry. Manual development integration uses the platform dev middleware Mock and the real Electron Host, including cancellation before browser approval. Production backend credentials and installer scheme registration require release-environment validation.

## Related

[Credential records and flows](2026-08-13-credential-records-and-authorization-flows.md) remains the generic credential authority. [Desktop wrapper](2026-09-10-desktop-web-wrapper.md) owns the transport composition.
