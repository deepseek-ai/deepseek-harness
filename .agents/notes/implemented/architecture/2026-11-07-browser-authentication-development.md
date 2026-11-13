# Agent Note: Authentication Provider integration

Status: implemented

English | [中文](2026-11-07-browser-authentication-development.zh.md)

## Problem

In the built-in authentication design, Connection combined BrowserAuth with its transport API, and route owners called its admission helpers. WebApp obtained a tokenized address through Connection. Splitting credential implementations requires concrete registration, route, event, and startup usage that does not put Token knowledge back into a transport or protocol handler.

The [Provider decision](2026-11-07-browser-authentication-providers.md) owns the rationale, credential compatibility, and equal treatment of Token, Desktop, and future Remote implementations. This note owns their integration with the final APIs.

## Decision

### Register a Provider and own its Peer

The Connection plugin provides the independent nested `connection.authentication` Service. A Provider plugin injects both `connection` and `connection.authentication`: the former creates Peers, while the latter owns registration and credential verification. The access path is a real Cordis service, not a getter constructing a temporary registry object.

This complete function-plugin example receives a trusted in-process verifier and principal from its Host. Its `Config.verify` is an illustrative application input, not a new DSH API or a substitute for implementing the credential algorithm.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest, Principal } from '@deepseek-ai/dsh-client-connection'

export const name = 'example-authentication'
export const inject = ['connection', 'connection.authentication']

export interface Config {
  principal: Principal
  verify(request: ConnectionTrustRequest): boolean
}

export function apply(ctx: Context, config: Config): void {
  const peer = ctx.connection.createPeer({ principal: config.principal })
  ctx.connection.authentication.register({
    authenticate(request) {
      return config.verify(request) ? peer : undefined
    },
  })
}
```

`createPeer` owns the Peer under the calling plugin scope; `register` owns the registration under that same caller scope. A shared-identity Provider retains one Peer as above. A session-based Provider instead retains its own credential-to-Peer records and returns the corresponding existing Peer. The Host fixes `principal` and optional `interactions` at creation; neither is a client-selected authorization claim.

`register` returns an asynchronous disposer whose call synchronously withdraws the record. Authentication snapshots registration order, skips records withdrawn during verification, and rechecks a returned Peer and the request before accepting. New registrations participate in subsequent requests. `authenticate` returns the first live Peer,401 for ordinary refusal, or503 when a verifier failed and none succeeded. Source rejection remains Connection's separate403 decision. The [implementation](../../../../packages/client/connection/src/authentication.ts) contains these lifecycle checks.

### Declare route admission and consume the selected Peer

`register`, `registerFallback`, and `registerUpgrade` accept `auth: 'anonymous' | 'required' | 'deny'` or a synchronous selector. The default is `required`. WebServer matches first, applies policy, obtains Connection's source and credential decision, and passes the selected Peer to the handler. `deny` rejects without invoking authentication; with no authorization listener, `required` returns503 and `anonymous` permits access.

The example below registers ordinary business handlers. The Host supplies `Config.upgrade`, its existing protocol implementation; it is not another framework operation. The HTTP assertion reflects this route's `required` policy, while the shared handler type also supports anonymous routes with no Peer.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

export const name = 'example-protected-routes'
export const inject = ['webServer']

export interface Config {
  upgrade: WebUpgradeRoute['handler']
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/identity',
    auth: 'required',
    handler(_req, res, peer) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(peer!.id)
    },
  }))
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/example/socket',
    auth: 'required',
    handler: config.upgrade,
  }))
}
```

HTTP handlers receive `(req, res, peer?)`, upgrade handlers receive `(req, socket, head, peer?)`, and resources retain `resource(request, peer?)`. Business handlers do not run another Provider pass. Direct administration routes outside Gateway, including Inspector and open-in-app, require an owner Peer before accessing Host resources. Trusted in-process `readResource(request, peer)` keeps its explicit Peer without network source or credential checks, but still honors `deny`. Admission failures carry `Cache-Control: no-store`.

### Use scoped WebServer events

Every WebServer event has the corresponding WebServer as its Cordis thisArg. Request dispatch uses the service instance; WebApp entry collection passes `ctx.webServer`. Ordinary listeners match the `webServer` isolation of that subject, including the existing index-injection event. `{ global: true }` explicitly receives events across service isolations in the same application. Peer data does not select event listeners. The [WebServer reference](../../../../packages/host/webserver/README.md) defines custom-carrier obligations.

| Event | Mode | Final integration |
|---|---|---|
| `webserver/request` | waterfall | Runs before route selection; Token exchanges root Token queries, and the account plugin handles its validated OAuth callback |
| `webserver/authorize` | bail | Resolves the matched route's source and credential admission; the first decision wins |
| `webserver/upgrade` | waterfall | Runs after admission and before the protocol handler, carrying the already selected Peer |
| `webserver/index-inject` | emit | Collects page or Worker startup data for the supplied Peer within the server isolation |
| `webserver/entry-url` | emit | Collects complete entry URLs for the supplied base address within the server isolation |

Waterfall listeners own the response or Socket when they handle a request; otherwise they await `next()`. Exceptions are contained by the carrier and end that response or Socket. Source policy is not disabled for every anonymous route to accommodate a login protocol.

The account plugin registers a temporary callback listener before generic admission. It matches the initiating redirect URI's authority and exact path, then preserves GET, single state/code values, constant-time state comparison, active-attempt checks, expiry, cancellation, and S256 PKCE. Thus a valid cross-site browser return can finish without bypassing those checks or weakening unrelated anonymous routes. The listener leaves with the attempt; it does not import a WebServer implementation helper.

### Keep Socket policy with the issuing product

Token's listener sits beside its `/connect` route and acts only on `/api/remote.mux`. It recognizes its own API Peer by map identity, rejects a second mux Socket with409, and synchronously removes the credential before awaiting Peer and Socket cleanup. Closing an Inspector CDP Socket does not claim or revoke that API session. Other Providers retain their own lifetime policies; Gateway only performs protocol upgrade with the supplied Peer.

An upgrade fixes the Peer for that connection. Later HTTP requests authenticate again. Token's shared browser Peer survives individual Socket closure; an API Peer follows its existing mux lifetime. Already-admitted unary calls retain their cancellation scope. The [mux regression](../../../../packages/api/gateway/tests/operator-connect.host.spec.ts) and [API connect decision](2026-10-09-operator-scoped-connect-handshake.md) cover this distinction.

### Let WebApp publish complete entry URLs

WebApp keeps `publicUrl`, `printUrl`, and `openBrowser`; both output flags default true. After Loader settlement and startup audit, it emits `webserver/entry-url` with its WebServer subject, ordinary base URL, and an initially empty `WebEntryUrl[]`. Each entry carries `label`, complete `url`, and boolean `open`.

Token contributes its signed `dsh web` URL without reading WebApp services. A Provider with no user-facing entry contributes nothing; another product can contribute its own label and complete URL. WebApp prints each `label: url` line when enabled, and opens only the first `open: true` entry when browser opening is enabled outside SSH. An empty list causes no output or browser opening. The process credential remains sensitive even though the integration exposes no raw Token getter.

Desktop's parent owns a fresh private credential per Host process and delivers it before ready. The Desktop Provider creates its Peer and registers verification through the same authentication Service. Electron uses its locally assembled `authenticationCookie`; runtime smoke and other parent-process consumers do not attempt a Token exchange using the ordinary ready URL. Renderer startup data and the wire ready message contain no private credential.

## Testing

| Affected behavior | Before | Final behavior and coverage |
|---|---|---|
| Provider registration | Only built-in BrowserAuth supplied network identity | Ordered independent verifiers select one live Peer; scope unload, verifier failure, and cancellation are covered by [authentication tests](../../../../packages/client/connection/tests/authentication.host.spec.ts) |
| HTTP and upgrade integration | Consumers called Connection admission | Route auth supplies the Peer once; real [Provider transport tests](../../../../packages/api/gateway/tests/authentication-provider.host.spec.ts) exercise both carriers |
| Server isolation | Route tables were per instance; index injection was root-wide | All five events use the WebServer subject; [server](../../../../packages/host/webserver/tests/event-isolation.host.spec.ts) and [application](../../../../packages/bundle/web-app/tests/event-isolation.host.spec.ts) tests cover ordinary and global listeners and a preserved external Host |
| Browser OAuth return | The callback validated state and PKCE | The scoped pre-route callback retains validation and accepts real cross-site navigation; [account tests](../../../../packages/credentials/deepseek-account/tests/account.spec.ts) retain wrong-Host and SSH-forwarding coverage, and [Chromium](../../../../apps/web/tests/account-login.e2e.ts) asserts the actual Fetch Metadata header |
| Startup output | WebApp printed/opened one Connection-produced login URL | [Startup tests](../../../../packages/bundle/web-app/tests/startup.host.spec.ts) cover ordered entries, first eligible opening, empty lists, readiness and SSH suppression |
| Desktop runtime consumers | A tokenized ready URL was exchanged for a Cookie | [Runtime smoke tests](../../../../apps/desktop/tests/smoke-runtime.spec.ts) use the private Cookie on the HTTP probes; [built Remote tests](../../../../packages/api/remotes/tests/built-lib.e2e.ts) collect the current Provider's entry and pass the admitted Peer |

## Alternatives considered

**Keep authentication behind per-request wrappers on Connection.** A separately registered Service exposes its ownership and required injection directly; it does not allocate a facade each time a consumer reads authentication.

**Add another route table or a request-context container.** Existing WebServer registrations already own dispatch, and Peer is the identity consumed downstream. Route policy and a trailing Peer parameter keep those owners intact.

**Pass an extra WebServer field in every request.** Cordis already supports a service subject and isolation filter. Using that mechanism also scopes page injection and entry collection without adding payload fields.

**Give Token the WebApp address service or browser opener.** That creates a reverse dependency on the composing bundle. WebApp owns publication timing and actions; Providers contribute complete entries through the shared event.

## Consequences

Credential implementations need no Gateway change, but custom carriers must emit events with their WebServer subject and pass the admitted Peer to protocol handlers. Plugins consuming the nested authentication service declare `connection.authentication` in their injections. Explicitly global event listeners remain responsible for whether sharing data across server instances is appropriate.

Removing a Provider registration and disposing its Peer are distinct operations. A product that shares one Peer also shares its termination scope; a product with independent credentials owns its own Peer records and revocation policy. The integration adds neither a universal Socket policy nor another authentication privilege tier.

The [Provider decision](2026-11-07-browser-authentication-providers.md) owns protocol compatibility and deployment consequences. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/guide.md) owns manual configuration migration and carrier updates; this record describes the implemented integration rather than a future Remote product.
