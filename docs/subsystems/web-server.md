# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) provides the GUI Host's HTTP or TLS listener, route matching and admission, optional gzip, index rendering, and one fallback. Feature plugins register their own routes; Connection supplies source and credential decisions through `webserver/authorize`. The carrier passes each admitted Peer directly to the handler or resource rather than constructing a request-context container ([layering reference](../../packages/boot/app-boot/README.md)).

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse, peer?: PeerScope) => void | Promise<void>
  /** Defaults to required. Anonymous handlers may receive no Peer. */
  auth?: WebAuthenticationRule
}
```

```ts type-equiv
/**
 * Answers one GET or HEAD request with a Fetch response and its admitted Peer.
 * Anonymous HTTP admission may omit the Peer; an in-process
 * {@link WebServer.readResource} read passes the Peer its caller admitted.
 */
type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>
```

```ts type-equiv
/** One named route answered by a resource instead of a handler. */
interface WebResourceRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Answers HTTP GET and HEAD requests and in-process reads. */
  resource: WebResource
  /** Defaults to required; in-process reads still enforce deny. */
  auth?: WebAuthenticationRule
}
```

All `webserver/*` events use the corresponding WebServer as their dispatch subject, including `index-inject` and `entry-url`. Ordinary listeners match the emitter's `webServer` isolation; explicit `{ global: true }` listeners bypass that filter. Passing a Peer as event data does not select listeners. Custom carriers and application emitters must supply the WebServer subject.

Match order is exact, longest prefix, then the single-owner fallback; upgrades match exact paths. After matching, `auth` resolves to `anonymous`, `required` (default), or `deny`, either directly or through a synchronous request selector. `deny` returns 403 without an authorization event. Other policies emit synchronous `webserver/authorize`; the first decision wins. Without a decision, `anonymous` allows and `required` returns 503. Connection checks sources for both and calls ConnectionAuthentication only for authenticated routes. Anonymous assets are therefore credential-free, not exempt from active Connection source policy.

Handlers receive the admitted Peer as their trailing parameter; resources receive it through the existing `resource(request, peer?)` argument. Authenticated routes require a live Peer; anonymous routes may omit it. After admission, resources accept only GET/HEAD. Trusted `readResource(request, peer)` follows the same match order and reaches only resources, bypassing source and credential checks but still returning 403 for a resolved `deny`. The [frontend fallback](../../packages/host/frontend-static/README.md) selects authenticated index access and anonymous static assets, then renders index startup data for the supplied Peer.

`webserver/request(request, response, next)` remains an HTTP waterfall before route selection and admission; a listener owns the response or awaits `next()`. The [Token plugin](../../packages/host/authentication-token/README.md) uses it for root Token exchange and registers `/connect` with anonymous auth, verifying the launch token after Connection source checks. Page resources consume their admitted Peer without repeating authentication.

After successful upgrade admission, `webserver/upgrade(req, socket, head, peer, next)` runs before the registered protocol handler. It carries the admitted Peer, or `undefined` for anonymous access; denied requests never enter it. Listeners handle the Socket or await `next()`; the fallback awaits the route handler, including asynchronous completion. Middleware or handler failures are logged and destroy the Socket. On `/api/remote.mux`, Token applies single-Socket ownership and credential revocation only to API Peers in its own map; other Providers delegate without Token policy.

`webserver/entry-url(baseUrl, entries)` synchronously collects complete entry URLs for a supplied server base URL as `WebEntryUrl` records with `label`, complete `url`, and boolean `open`. WebApp emits it after Loader settlement and startup audit, prints each entry when configured, and opens only the first eligible entry outside SSH. An empty list produces neither output nor opening. Token contributes its signed URL without reading WebApp services; public-address configuration remains in WebApp.

<a id="config"></a>

## Config

```ts type-equiv
/** Web server listen, TLS, and response-compression config. */
interface Config {
  /**
   * Listen address: a concrete IPv4 or IPv6 literal of one local interface,
   * for example the container's own Pod address from `hostname -i`. A loopback
   * literal (any address in 127/8, `::1`, or a mapped form of either) keeps the
   * server on this machine; any other literal serves the network that address
   * belongs to, over plain HTTP unless `tls` is set. The unspecified address —
   * IPv4 any, IPv6 any, and the IPv4-mapped forms of IPv4 any — is rejected at
   * load: it would expose the port on every interface at once.
   */
  host: string
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Serve HTTPS with this certificate and key instead of plain HTTP. Both files
   * are read once, before the listener binds: an unreadable or empty file,
   * invalid PEM, or a key that does not match the certificate rejects
   * initialization rather than falling back to HTTP. The material is never
   * re-read, so replacing a certificate takes a reload. Omitted or null listens
   * over plain HTTP.
   */
  tls?: TlsConfig
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}
```

```ts type-equiv
/**
 * TLS material for the HTTPS listener: one certificate chain file and the
 * private key file it pairs with. Both hold PEM text and both resolve against
 * the process working directory.
 */
interface TlsConfig {
  /** Certificate chain file, leaf certificate first, PEM, no passphrase. */
  certFile: string
  /** Private key file for the chain's leaf certificate; unencrypted PEM. */
  keyFile: string
}
```

No composition can bind every interface at once: the unspecified address is rejected at load. The exported `isWildcardHost` and `isLoopbackHost` classify a bind address from its parsed value, and an IPv6 `%zone` is kept for `listen` while classification reads the address alone. The carrier enforces route auth declarations; Connection owns source checks and ConnectionAuthentication owns credential verification. It serves plain HTTP unless `tls` supplies a certificate and key. `compression` defaults to `none`; the shipped Web bundle selects gzip level 1 with a 1024-byte threshold. The shipped `dsh web` command selects loopback by default and accepts one concrete `--host` address, warning at startup when a non-loopback bind serves plain HTTP; its Connection plugin checks Host/Origin on matched anonymous and authenticated routes and verifies credentials where authentication is required, and the bind address plus `--trusted-host` govern which browser Host is accepted; `--public-url` changes only the advertised URL. Other compositions own their bind and route-authentication policy. The dist location is an assembly fact of the frontend plugin that claims the seat.

## The service

The nested `connection.authentication` service selects a Peer through registered Providers; Connection applies source policy and WebServer passes the selected Peer to each call. The [Token plugin](../../packages/host/authentication-token/README.md) contributes its signed login URL; WebApp owns startup printing and browser opening. [Desktop](../../apps/desktop/README.md#application-overview) registers a separate Provider using a credential delivered over its private parent–Host IPC channel; its ready message carries the ordinary Host address and startup injections.

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. The `tls` pair is read once before the listener binds, and an unreadable, empty, or mismatched pair rejects initialization the same way instead of falling back to HTTP. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. Gzip wraps eligible socket-backed responses inside the server, so handlers keep direct `ServerResponse` ownership, and a resource hands the service a `Response` to write back. Existing content encodings, `Cache-Control: no-transform`, ranges, SSE, ZIP, and the packaged `.gz` Worker image remain identity responses. `collectIndexInjections(peer)` gathers structured `IndexInjection` rows over one `webserver/index-inject` emit that passes the Peer the page speaks for, and `renderIndex(html, peer)` renders them into successful root and configured index responses before applying the raw `tapIndex(transform)` escape-hatch transforms in registration order; [dsh-client-modules](../../packages/client/modules) answers the event with the boot manifest rows. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0, and `protocol` reports the scheme the listener serves (`http:` or `https:`).

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. A TLS socket counts as a connection only after its handshake, so the server tracks raw TLS sockets beside upgraded ones and destroys both at disposal. WebApp owns entry-URL printing and browser opening; this server owns HTTP delivery. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnection--hostconnectionhandle"></a>

### `ctx.connection` — `HostConnectionHandle`

Host `ctx.connection` members consumed by transport-independent adapters.

```ts cordis-catalog
/**
 * Compose exact Fetch routes and the shared-channel RPC interceptor.
 * @param channel - shared channel mounted by Connection.
 * @returns Fetch handler for trusted, authenticated requests.
 */
createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

/**
 * Apply Host/Origin checks and admit the first live Peer returned by a registered credential verifier.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns the credential's Peer, or the rejection status.
 */
admit(request: ConnectionTrustRequest): PeerAdmission

/**
 * Create an independent in-process Peer, disposed with the Context that read `ctx.connection`.
 * @param options - fixed principal and interaction participation (default answer).
 * @returns a new Peer distinct from every other Peer.
 */
createPeer(options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' }): PeerScope
```

Types: [Principal](typert.md)

Source: [`packages/client/connection/src/rpc.ts`](../../packages/client/connection/src/rpc.ts)

<a id="ctxconnectionauthentication--connectionauthentication"></a>

### `ctx.connection.authentication` — `ConnectionAuthentication`

Credential verifier registry whose registrations belong to the calling plugin.

```ts cordis-catalog
/**
 * Add a credential verifier after the existing registrations.
 * @param provider - verifier owning its credential and Peer selection.
 * @returns disposer withdrawing this registration; the calling scope also withdraws it on unload.
 */
register(provider: AuthenticationProvider): () => Promise<void>

/**
 * Verify credentials without applying an HTTP response or source policy.
 * @param request - current carrier headers and cancellation facts.
 * @returns the first live Peer, 401 if no provider accepts, or 503 when verification failed without success.
 */
authenticate(request: ConnectionTrustRequest): PeerAdmission
```

Types: [AuthenticationProvider](../../packages/client/connection/README.md#browser-authentication-and-request-trust)

Source: [`packages/client/connection/src/authentication.ts`](../../packages/client/connection/src/authentication.ts)

<a id="ctxwebapp--webapp"></a>

### `ctx.webApp` — `WebApp`

The Web GUI this process serves, provided by the `web-runtime` row.

```ts cordis-catalog
/**
 * The URL this GUI advertises, also used for `DSH_WEB_URL` and the startup URL line.
 * @returns the configured `publicUrl`, otherwise the listener origin.
 */
getAdvertisedUrl(): string
```

Source: [`packages/bundle/web-app/src/index.ts`](../../packages/bundle/web-app/src/index.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation loads any configured TLS material, then listens immediately; a material or listen failure rejects initialization, and the boot process reports the failed fiber. Route registration order does not affect requests because configured named routes must be distinct, and a request no named route matches is answered 404 until the fallback owner registers. HTTP and upgrade admission refusals carry `Cache-Control: no-store`.

```ts cordis-catalog
/**
 * The root URL local clients use to reach the bound listener: the protocol,
 * the {@link bindUrlHost} form of the bind address, and the listening port.
 * @returns the origin, for example `http://127.0.0.1:3080`.
 * @throws before `listen` binds a port, or when the bind address has no URL form.
 */
getOrigin(): string

/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler or resource.
 * @returns the disposer removing the route.
 */
register(route: WebRoute | WebResourceRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler or resource answering every request
 * no named route matches (the SPA dist server in the shipped Web
 * composition). One owner only — a second registration throws, because two
 * fallbacks cannot compose.
 * @param fallback - a handler owning the full response lifecycle of
 * unmatched requests, or an object declaring `handler` or `resource` and auth.
 * @returns the disposer releasing the seat.
 */
registerFallback(fallback: WebRoute['handler'] | WebFallback): () => void

/**
 * Read the response an HTTP request for the same URL would receive, as the
 * resource computes it for `peer`, without an HTTP exchange. The request
 * path picks the responder by the HTTP match order — exact, longest prefix,
 * then the fallback — and only a resource answers. This method checks no
 * cookie, Host, or Origin: the caller admits the reader before reading.
 * A resolved deny policy returns 403 even for an explicitly admitted Peer.
 * @param request - the read; its URL path selects the responder.
 * @param peer - the Peer the read speaks for, passed to the resource.
 * @returns the resource's response, without a body for HEAD as over HTTP;
 * 405 with `Allow: GET, HEAD` for any other method, checked before matching,
 * where over HTTP a handler route or an unmatched path answers such a
 * method itself; 404 when the path matches a handler route, or reaches the
 * fallback seat while it is unclaimed or holds a handler. A resource that
 * throws rejects the read, where an HTTP request would receive 400.
 */
async readResource(request: Request, peer: PeerScope): Promise<Response>

/**
 * Register a raw-HTML index transform, the escape hatch for markup no
 * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
 * registration order after rendering the structured rows.
 * @param transform - pure html-to-html function.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string) => string): () => void

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
applyIndexTaps(html: string): string

/**
 * Gather the structured injection table for one Peer: one
 * `webserver/index-inject` emit, every subscriber pushes its current rows.
 * Fresh per call, so subscribers read live state (module graph, theme
 * preference, the Peer's access) at emit time.
 * @param peer - the Peer the page speaks for.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(peer: PeerScope): IndexInjection[]

/**
 * Render one index.html body for one Peer: the structured injection table
 * first, then the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @param peer - the Peer the page speaks for.
 * @returns the transformed body.
 */
renderIndex(html: string, peer: PeerScope): string
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="connection-events"></a>

### `connection/*` events

<a id="connectionrequest--waterfall"></a>

#### `connection/request` — waterfall

Admit or wrap an authenticated shared API request, including body transfer. Existing requests continue when a listener refuses subsequent requests.

```ts cordis-catalog
/**
 * Admit or wrap an authenticated shared API request, including body transfer.
 * Existing requests continue when a listener refuses subsequent requests.
 * @param request - Authenticated incoming HTTP request.
 * @param response - Response owned until the delegated bridge settles.
 * @param next - Delegate to the next listener or the shared API bridge.
 * @mode waterfall
 */
'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
```

Source: [`packages/client/connection/src/index.ts`](../../packages/client/connection/src/index.ts)

<a id="webserver-events"></a>

### `webserver/*` events

<a id="webserverauthorize--bail"></a>

#### `webserver/authorize` — bail

Admit a matched request synchronously; the first decision wins.

```ts cordis-catalog
/**
 * Admit a matched request synchronously; the first decision wins.
 * @param request - headers, target, transport, and available cancellation state.
 * @param policy - resolved route policy; deny never emits this event.
 * @mode bail
 */
'webserver/authorize'(request: WebAuthRequest, policy: WebAuthPolicy): WebAdmission | undefined
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="webserverentry-url--emit"></a>

#### `webserver/entry-url` — emit

Collect complete entry URLs for an advertised server address.

```ts cordis-catalog
/**
 * Collect complete entry URLs for an advertised server address.
 * @param baseUrl - advertised server base URL without provider credentials.
 * @param entries - entries appended synchronously in listener order.
 * @mode emit
 */
'webserver/entry-url'(baseUrl: string, entries: WebEntryUrl[]): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table for the page `peer` speaks for. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table for the page `peer` speaks
 * for. Emitted on every index render and every worker boot-payload
 * request; listeners push their current rows, so a row's data is read
 * fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @param peer - The Peer the rendered page speaks for.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[], peer: PeerScope): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="webserverrequest--waterfall"></a>

#### `webserver/request` — waterfall

Handle an HTTP request before named-route and fallback dispatch.

```ts cordis-catalog
/**
 * Handle an HTTP request before named-route and fallback dispatch.
 * @param request - original incoming HTTP request.
 * @param response - response owned by the listener or its delegated handler.
 * @param next - dispatch to the next listener or the matching route.
 * @mode waterfall
 */
'webserver/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="webserverupgrade--waterfall"></a>

#### `webserver/upgrade` — waterfall

Handle an admitted upgrade before its registered protocol handler.

```ts cordis-catalog
/**
 * Handle an admitted upgrade before its registered protocol handler.
 * @param request - original upgrade request.
 * @param socket - transport owned by the upgrade.
 * @param head - bytes received after the HTTP headers.
 * @param peer - authenticated identity, absent for anonymous admission.
 * @param next - delegate to the next listener or protocol handler.
 * @mode waterfall
 */
'webserver/upgrade'( request: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope | undefined, next: () => Promise<void>, ): Promise<void>
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
