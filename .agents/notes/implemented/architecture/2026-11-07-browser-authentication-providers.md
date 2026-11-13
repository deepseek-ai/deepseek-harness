# Agent Note: Peer-based authentication Providers

Status: implemented

English | [中文](2026-11-07-browser-authentication-providers.zh.md)

## Problem

The Host serves tool-capable operations, so a reachable address cannot establish caller identity. Browser login, Desktop access, and remote invitation or pairing flows need different credential implementations without giving each transport a different authorization model.

Before this separation, WebServer owned HTTP and upgrade listeners and their per-instance route tables. Connection constructed the built-in BrowserAuth, checked request sources, verified browser and API Cookies, and managed the existing API Peer attachment. Route owners called Connection admission methods themselves. WebApp asked Connection to add the launch token to its advertised address, then printed or opened that URL. The old `webserver/index-inject` event broadcast within the Cordis root independently of the route tables.

That arrangement made the default Token implementation part of the generic connection service. Another authentication product needed the same Peer result but could not supply its own verifier through a common registration interface.

## Decision

### Independent authentication and equal Providers

ConnectionAuthentication is an independent Service in the Connection package, registered as `connection.authentication` and accessed through `ctx.connection.authentication`. It owns credential-verifier registration and selection. Connection retains request-source policy, Peer creation, and RPC/Fetch operations; WebServer enforces route admission and supplies the selected Peer to handlers. Gateway and RemoteAccess authorize operations using that Peer.

An AuthenticationProvider synchronously returns an existing live Peer or `undefined`. ConnectionAuthentication tries Providers in actual registration order and accepts the first live result. An ordinary refusal or ended Peer permits a later Provider to succeed; an exception also permits later success. With no success, ordinary refusal returns401 and a verification failure returns503. Request cancellation stops admission. This is one selection pass, not a priority or privilege ranking between credential kinds.

| Access method | Credential implementation | Peer ownership |
|---|---|---|
| Web and API Token | The Token plugin verifies its process-token exchanges and signed Cookies | Browser v1 Cookies share a plugin-owned Peer; `/connect` v2 Cookies identify an existing independent API Peer |
| Desktop | The Desktop Provider verifies the private credential delivered over parent–Host IPC | One Peer belongs to the Provider for that owned Host process |
| Remote | The same Provider interface accepts a product's invitation or pairing verifier | The product determines its own principal, credentials, and Peer lifetime; the Remote product itself is not implemented |

The shared authentication extension is complete independently of the future Remote product. The [integration note](2026-11-07-browser-authentication-development.md) gives a typed Provider example and the route and event usage.

### Identity, authorization, and lifetime remain separate

The Host fixes `peer.principal` when creating the Peer; the client cannot choose it through a request field. Authentication establishes that identity, not permission for every operation. RemoteAccess continues to evaluate business permissions, and `peer.interactions` continues to control forwarded-event participation rather than an authentication level.

Each registering plugin owns its registration, and each Peer creator owns the Peer scope. Credential withdrawal prevents later authentication; ending a Peer also ends its Peer-scoped communication. Already-admitted unary requests retain their request-level cancellation semantics. Asynchronous Provider preparation can affect actual registration order, so deployments cannot infer a separate priority from credential names.

### Effects on HTTP, events, and startup

WebServer route registrations declare `anonymous`, `required`, or `deny`; omission means `required`. Protected handlers receive the Peer selected by centralized admission rather than calling each verifier. Anonymous routes skip credentials but still undergo the active Connection source policy. Trusted in-process resource reads retain their explicit Peer and still honor `deny`.

All five `webserver/*` events carry the corresponding WebServer as their Cordis dispatch subject. Ordinary listeners follow `webServer` service isolation; explicit `global: true` listeners opt out. This applies to request admission, upgrade middleware, the existing page-injection event, and entry-URL collection. Service isolation is a composition mechanism, not a sandbox for same-process plugins.

The Token plugin owns root Token exchange and `/connect` issuance. Its upgrade middleware claims its API Peers only at `/api/remote.mux`, preserving one Socket per API Peer, duplicate409, and synchronous credential revocation before asynchronous cleanup. Inspector and other upgrade routes do not claim that lifecycle. WebApp owns readiness, `printUrl` and `openBrowser` (both default true), SSH suppression, and publication: it collects complete entries, prints them in order, and opens only the first eligible one. No entries means no output or opening.

### Preserved protocols and explicit limits

The [browser Token protocol](2026-08-24-browser-token-authentication.md) retains the process token, signed authority-bound Cookie, persistent `client-connection/browser-session` signing record, expiry checks, and listener-controlled `Secure` attribute. The [API connect decision](2026-10-09-operator-scoped-connect-handshake.md) retains independent API Peers, HTTP before Socket attachment, interaction participation, and mux cleanup. A valid v2 Cookie can also authenticate a protected page; page access does not create another credential tier.

Desktop uses its private credential directly rather than exchanging a Token URL. The renderer receives ordinary addresses and startup data, not the private credential; the wire `ready` message contains no secret. Desktop can also offer Token login and its printed entry URL. Normal shutdown or parent disconnection while awaiting the Desktop credential ends startup without a fatal authentication error; invalid or repeated credentials remain failures.

Token activation failure may leave the application running without that Provider; it never grants unauthenticated access to a protected route. Token owns `cookieMaxAgeDays`, default30 days. Operators manually move an old Connection setting to Token: the old location is not migrated or rejected and does not affect the Token lifetime. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/guide.md) owns that migration.

## Testing

The before/after comparison uses the original built-in-authentication design as its baseline.

| Affected behavior | Before | Final behavior |
|---|---|---|
| Credential selection | Connection directly used BrowserAuth | Token and Desktop use the same ordered Provider service; another Provider can succeed after refusal or failure |
| Protected HTTP and upgrades | Route owners invoked Connection admission | Route policy centralizes admission and passes one selected Peer to the handler |
| Credential persistence | Browser Cookies survived restart; API Peers did not | The same Token formats, authority checks, restart behavior, and API retention rules remain |
| API lifecycle Socket | Gateway attachment owned one API Peer | Token's mux middleware retains duplicate409 and close-time revocation without claiming other upgrades |
| Event scope | Routes were instance-owned; page injection broadcast | WebServer subjects filter all five events by service isolation, with an explicit global escape |
| Browser startup | WebApp printed/opened one Connection-produced URL | WebApp keeps its defaults and readiness rules while publishing ordered Provider contributions |
| Desktop startup | Desktop exchanged the launch URL for a Cookie | Desktop uses private IPC credentials; normal early shutdown is acknowledged |

The [Connection tests](../../../../packages/client/connection/tests/authentication.host.spec.ts), [real transport composition](../../../../packages/api/gateway/tests/authentication-provider.host.spec.ts), [mux lifecycle tests](../../../../packages/api/gateway/tests/operator-connect.host.spec.ts), and [WebApp isolation tests](../../../../packages/bundle/web-app/tests/event-isolation.host.spec.ts) cover these behaviors. The integration note covers callback and custom-carrier verification.

## Alternatives considered

**Keep Token-specific operations inside Connection.** This couples every authentication product to the default credential implementation. A generic credential registry returns the Peer already consumed by the transport and authorization layers.

**Return a boolean or a binding identifier and resolve the Peer later.** A boolean leaves identity unresolved; a binding identifier adds another mapping and owner. Providers already own their Peers, so successful verification returns that object directly.

**Authenticate separately in each HTTP and upgrade handler.** Repeated checks can disagree and omit new routes. Route policy and centralized admission make the requirement explicit while leaving endpoint-specific tickets and input validation with the endpoint.

**Put product Socket policy in a Peer subtype or binding API.** The single-Socket rule belongs to `/connect`'s mux session, not every Peer. Business-owned upgrade middleware preserves that rule without a generic Peer policy flag or a Gateway dependency on Token.

## Consequences

Adding a credential implementation does not change Gateway dispatch or the existing Peer protocol. Provider initialization, credential storage, login interaction, and session lifetime remain product responsibilities. Default Token and Desktop use the same interface that a Remote product can adopt, without claiming that invitation or approval UI already exists.

Central route admission changes the default for previously unclassified routes to `required`; public endpoints need explicit policy. Instance-scoped events prevent an isolated WebServer from inheriting another server's ordinary listeners, but a deliberately global listener remains application-wide. A credential-bearing entry URL is sensitive output even though no raw Token getter is exposed.

This decision partially extends the implementation ownership in the browser Token, API connect, and [request-source policy](2026-07-28-api-browser-trust-boundary.md) records. Those records remain active for their credential, lifecycle, and security rationale; none is fully superseded or archived.
