# HTTP 服务器

[English](web-server.md) | 中文

[dsh-host-webserver](../../packages/host/webserver) 是 GUI Host 的浏览器 HTTP 载体：它是一个提供 `ctx.webServer` 的 `node:http` 插件，包含具名路由注册表、可选的 gzip 响应压缩、index.html 转换回调，以及一个可由插件认领的回退处理器。它不属于 agent loop（智能体循环），也不是能力 seam；它不了解任何 harness 概念。其他插件负责注册所有功能路由，包括 `/api` 桥接、插件 bundle 和 HMR（热模块替换）事件流（[分层说明](../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)）。该服务器只服务浏览器：Electron 通过 `file://` 加载已构建文件，并经 IPC 桥接发送 fetch 请求，不使用本服务器。

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
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

匹配顺序固定：先查 exact 表，再取最长匹配前缀，最后落到已注册的回退。注册顺序不携带任何面向请求的语义：具名路由在组合上互不相交，任何未被具名路由认领的请求都由回退席位应答；席位只有一个所有者，第二次注册会抛出异常。发布的 Web 组合用 [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts) 认领席位，即遵循固定语义的 SPA dist 服务器：Connection 在读取 dist 根目录和配置 index 的 HTML 前完成认证；非 index 资产保持公开；非 GET/HEAD 返回 405，越出 dist 根目录的遍历返回 403，现有文件直接提供，缺失或不是文件的目标返回空的 404，未知扩展名按 octet-stream 发送。

## 配置

```ts type-equiv
/** Web server listen and response-compression config. */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}
```

`host` 只接受 `127.0.0.1`（默认姿态）和 `0.0.0.0`（刻意的网络暴露）。载体本身不拥有 TLS、认证或 Origin 策略，因此绑定到非回环地址会暴露服务器，除非组合层提供这些控制。`compression` 默认为 `none`；随附的 Web 组合选择 gzip level 1 和 1024 字节阈值。随附的 `dsh web` 命令选择 loopback 并拒绝 `--host 0.0.0.0`；其 Connection 插件为每个 Host API route 与 stream 提供 Host/Origin 校验和浏览器会话认证。其他组合自行拥有绑定与路由认证策略。dist 位置是认领席位的前端插件的组装事实。

## 服务

`WebServer`（`ctx.webServer`）在激活时立即监听；监听失败（EADDRINUSE 等）会使初始化被拒绝，启动进程会报告失败的 fiber。`register(route)` 添加一条具名路由并返回其 disposer；重复的 `(kind, path)` 抛出异常，因为路由模式是组合层约定，冲突即配置错误。Gzip 在服务器内部包装符合条件且基于 socket 的响应，因此 route handler 继续直接持有 `ServerResponse`，服务也不新增响应写出 API。已有内容编码、`Cache-Control: no-transform`、范围响应、SSE、ZIP 与打包后的 `.gz` Worker 镜像均保持 identity 响应。`collectIndexInjections()` 经一次 `webserver/index-inject` emit 收集结构化 `IndexInjection` 行，`renderIndex(html)` 把它们渲染进成功的根路径和配置 index 响应，随后再按注册顺序应用原始的 `tapIndex(transform)` 逃生口转换；[dsh-client-modules](../../packages/client/modules) 以启动 manifest（元数据清单）行回应该事件。`port` 读取监听端口，包括 `config.port` 为 0 时操作系统分配的端口。

处理过程中抛出异常的请求（畸形的 % 转义撞上 `decodeURIComponent`、客户端在请求体中途断开）会记录为警告并应答 400（响应头已发出时则销毁 socket），绝不导致进程退出。dispose（资源释放）把 `close()` 与 `closeAllConnections()` 配对使用，因为处理器可能像 SSE（Server-Sent Events）那样保持响应打开，而这类连接永远不会自行结束；没有强制关闭，拆卸就会挂起。该包从不打印输出：URL 行归 shell 所有。逐包运维细节（含开发模式的 bundle 监视流水线）留在 [README](../../packages/host/webserver/README.zh.md) 中。

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
 * Apply Connection's Host/Origin checks and browser authentication to
 * another Web route.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns rejection status, or undefined when the route may accept the request.
 */
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

/**
 * Admit one request: it passes {@link requestRejection} and speaks for the
 * operator, or it is refused with that status.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns the operator Peer, or the rejection status.
 */
admit(request: ConnectionTrustRequest): PeerAdmission

/**
 * Authenticate one frontend index request, owning a token redirect or 401.
 * @param request - root or configured-index HTTP request.
 * @param response - response owned when the result is false.
 * @returns true only when the frontend may serve index.html.
 */
authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

/**
 * Add the fresh process token to an ordinary Web application URL.
 * @param baseUrl - clean application URL whose authority and mount are preserved.
 * @returns tokenized URL for initial login; a mount proxy strips its prefix before {@link authorizeIndex}.
 */
authenticatedUrl(baseUrl: string): string
```

Source: [`packages/client/connection/src/rpc.ts`](../../packages/client/connection/src/rpc.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.

```ts cordis-catalog
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws, because two fallbacks cannot
 * compose.
 * @param handler - owns the full response lifecycle of unmatched requests.
 * @returns the disposer releasing the seat.
 */
registerFallback(handler: WebRoute['handler']): () => void

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
 * Gather the structured injection table: one `webserver/index-inject` emit,
 * every subscriber pushes its current rows. Fresh per call, so subscribers
 * read live state (module graph, theme preference) at emit time.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(): IndexInjection[]

/**
 * Render one index.html body: the structured injection table first, then
 * the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
renderIndex(html: string): string
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

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table. Emitted on every index
 * render and every worker boot-payload request; listeners push their
 * current rows, so a row's data is read fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[]): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
