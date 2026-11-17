# HTTP 服务器

[English](web-server.md) | 中文

[dsh-host-webserver](../../packages/host/webserver) 提供 GUI Host 的 HTTP 或 TLS 监听、路由匹配与准入、可选 gzip、index 渲染及唯一回退。功能插件注册各自路由；Connection 通过 `webserver/authorize` 提供来源与凭据决策。载体直接向 handler 或 resource 传递准入 Peer，不构造请求上下文容器（[分层说明](../../packages/boot/app-boot/README.zh.md)）。

源码：[`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## 路由

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

所有 `webserver/*` 事件均以对应的 WebServer 为分发 subject，包括 `index-inject` 与 `entry-url`。普通监听器匹配发起者的 `webServer` isolation；显式 `{ global: true }` 监听器跳过该过滤。作为事件数据传入的 Peer 不决定监听器选择。自定义载体和应用发起者必须提供 WebServer subject。

匹配顺序为精确、最长前缀、唯一 owner 的回退；upgrade 精确匹配。匹配后，`auth` 直接或通过同步请求选择器解析为 `anonymous`、`required`（默认）或 `deny`。`deny` 不触发准入事件，直接返回403。其余策略触发同步 `webserver/authorize` 并采用首个决策；无人决策时匿名放行，认证返回503。Connection 对两者均检查来源，仅对认证路由调用 ConnectionAuthentication。因此匿名资源免凭据，但不能免除活动 Connection 的来源策略。

handler 通过末尾参数取得准入 Peer，resource 使用已有 `resource(request, peer?)` 参数。认证路由必须取得存活 Peer，匿名路由可省略。准入后 resource 只接受 GET/HEAD。可信 `readResource(request, peer)` 遵循同样的匹配顺序且仅访问 resource，跳过来源与凭据检查，但解析出的 `deny` 仍返回403。[前端回退](../../packages/host/frontend-static/README.zh.md)选择 index 认证访问与静态资源匿名访问，再为传入 Peer 渲染 index 启动数据。

`webserver/request(request, response, next)` 保持为路由选择与准入前的 HTTP waterfall；监听器拥有响应或等待 `next()`。[Token 插件](../../packages/host/authentication-token/README.zh.md)通过它处理根 Token 交换，并以匿名 auth 注册 `/connect`，在 Connection 来源检查后验证启动 Token。页面 resource 使用准入 Peer，不重复认证。

upgrade 准入成功后，`webserver/upgrade(req, socket, head, peer, next)` 在已注册协议 handler 前执行。它携带准入 Peer，匿名访问可为 `undefined`；被拒绝的请求不会进入。监听器自行处理 Socket 或等待 `next()`；waterfall 的末端等待路由 handler，包括其异步完成。中间件或 handler 失败时记录日志并销毁 Socket。在 `/api/remote.mux` 上，Token 仅对自己映射表内的 API Peer 执行单 Socket 所有权与凭据撤销；其他 Provider 委派后续处理，不应用 Token 策略。

`webserver/entry-url(baseUrl, entries)` 根据传入的服务器基地址同步收集完整入口 URL，以 `WebEntryUrl` 记录表示，字段为 `label`、完整 `url` 与布尔值 `open`。WebApp 在 Loader 装配结束并完成启动检查后触发，按配置逐行打印，并仅在非 SSH 下打开首个允许自动打开的入口。空列表不产生输出或打开动作。Token 无需读取 WebApp 服务即可贡献签名 URL；公开地址配置仍归 WebApp。

<a id="config"></a>

## 配置

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

没有组合能一次性绑定所有网络接口：未指定地址在加载时即被拒绝。导出的 `isWildcardHost` 与 `isLoopbackHost` 按解析后的地址值分类，IPv6 的 `%zone` 会保留给 `listen`，而分类只读取地址本身。载体执行路由 auth 声明；Connection 拥有来源检查，ConnectionAuthentication 拥有凭据验证；除非 `tls` 提供证书与密钥，否则以明文 HTTP 提供服务。`compression` 默认为 `none`；随附的 Web 组合选择 gzip level 1 和 1024 字节阈值。随附的 `dsh web` 命令默认选择 loopback 并接受一个具体的 `--host` 地址，非 loopback 绑定以明文 HTTP 提供服务时会在启动时警告；其 Connection 插件对匹配的匿名与认证路由检查 Host/Origin，并在要求认证时验证凭据，绑定地址加 `--trusted-host` 决定接受哪个浏览器 Host；`--public-url` 只改变公告的 URL。其他组合自行拥有绑定与路由认证策略。dist 位置是认领席位的前端插件的组装事实。

## 服务

嵌套服务 `connection.authentication` 通过注册的 Provider 选择 Peer；Connection 执行来源策略，WebServer 将选定 Peer 传给各次调用。[Token 插件](../../packages/host/authentication-token/README.zh.md)贡献签名登录 URL；WebApp 拥有启动打印和浏览器打开行为。[Desktop](../../apps/desktop/README.zh.md#application-overview)使用父进程与 Host 之间私有 IPC 通道交付的凭据，注册独立 Provider；其 ready 消息携带普通 Host 地址和启动注入。

`WebServer`（`ctx.webServer`）在激活时立即监听；监听失败（EADDRINUSE 等）会使初始化被拒绝，启动进程会报告失败的 fiber。`tls` 证书对在监听器绑定前读取一次；文件不可读、为空或二者不匹配时同样会使初始化被拒绝，而不是回退到 HTTP。`register(route)` 添加一条具名路由并返回其 disposer；重复的 `(kind, path)` 抛出异常，因为路由模式是组合层约定，冲突即配置错误。Gzip 在服务器内部包装符合条件且基于 socket 的响应，因此 handler 继续直接持有 `ServerResponse`，resource 则把 `Response` 交给服务写回。已有内容编码、`Cache-Control: no-transform`、范围响应、SSE、ZIP 与打包后的 `.gz` Worker 镜像均保持 identity 响应。`collectIndexInjections(peer)` 经一次传入页面所代表 Peer 的 `webserver/index-inject` emit 收集结构化 `IndexInjection` 行，`renderIndex(html, peer)` 把它们渲染进成功的根路径和配置 index 响应，随后再按注册顺序应用原始的 `tapIndex(transform)` 逃生口转换；[dsh-client-modules](../../packages/client/modules) 以启动 manifest（元数据清单）行回应该事件。`port` 读取监听端口，包括 `config.port` 为 0 时操作系统分配的端口，`protocol` 则报告监听器提供的协议（`http:` 或 `https:`）。

处理过程中抛出异常的请求（畸形的 % 转义撞上 `decodeURIComponent`、客户端在请求体中途断开）会记录为警告并应答 400（响应头已发出时则销毁 socket），绝不导致进程退出。dispose（资源释放）把 `close()` 与 `closeAllConnections()` 配对使用，因为处理器可能像 SSE（Server-Sent Events）那样保持响应打开，而这类连接永远不会自行结束；没有强制关闭，拆卸就会挂起。TLS socket 只有完成握手后才计入连接，因此服务器会把原始 TLS socket 与升级后的 socket 一并跟踪，并在 dispose 时销毁两者。WebApp 拥有入口 URL 的打印和浏览器打开行为，本服务器负责 HTTP 交付。逐包运维细节（含开发模式的 bundle 监视流水线）留在 [README](../../packages/host/webserver/README.zh.md) 中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Principal](typert.zh.md)

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

Types: [AuthenticationProvider](../../packages/client/connection/README.zh.md#browser-authentication-and-request-trust)

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
