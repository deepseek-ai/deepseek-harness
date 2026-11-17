---
description: "web GUI 宿主的 HTTP 服务器：具名路由与 upgrade 注册、可选的 TLS 监听、index 转换，以及服务 Web 壳 SPA dist 的唯一回退席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

## 概述

浏览器经由 `dsh-host-webserver` 通过 HTTP 访问 web GUI：一个 `node:http` 服务器——当 `tls` 指定证书与私钥时改用 `node:https`——其他插件在其中注册具名路由、upgrade 路由、index 启动输入与一个回退。它不提供任何文件服务——`/api` 桥接、插件 bundle、HMR（热模块替换）事件流与 SPA dist 都属于注册它们的插件。路由匹配顺序固定不变：先在整张表中匹配精确 route，再匹配最长前缀，最后交给回退。它只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把 webserver 组合为面向浏览器宿主的 HTTP 传输，然后让功能插件认领各自的路由。激活即开始监听；注册顺序不影响请求处理，因为具名路由组合起来互不相交。添加 `tls` 即可让同一批路由以 HTTPS 而非明文 HTTP 提供。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3000
```

`host` 接受本机某个接口的一个具体 IPv4 或 IPv6 字面量——例如容器自身来自 `hostname -i` 的 Pod 地址。回环字面量（127/8 内的任意地址、`::1`，或二者的 mapped 形式）把服务器留在本机；其他任何字面量都会在该地址所属网络上提供 HTTP，除非设置 `tls`，否则为明文。未指定地址——包括 Linux 视为 IPv4 any 的 IPv4-mapped 形式——会在加载时被拒绝，而不是一次性打开每个网络接口的端口。`port` 为 0 时请求 OS 分配端口；之后用 `ctx.webServer.port` 读取正在监听的端口，导出的 `isLoopbackHost(host)` 与 `isWildcardHost(host)` 按解析后的地址值分类，因此 mapped 或带 zone 的写法会按其指名的地址分类。点分四段式的 IPv6 尾部表示该地址自身的低 32 位，与 `listen` 的读法完全一致：`::0.0.0.1` 是回环 `::1`，而 `::127.0.0.1` 是非回环的 `::7f00:1`；`normalizeBindAddress(host)` 返回该地址的文本——真正 mapped 的 `::ffff:127.0.0.1` 为 `127.0.0.1`，`::0.0.0.1` 与 `::1%lo` 为 `::1`——可直接用作 URL host。`bindUrlHost(host)` 把该文本写成 URL host（IPv6 加方括号），对 URL 无法携带的非回环带 zone 地址返回 `undefined`；`ctx.webServer.getOrigin()` 把它与协议、监听端口组合成本机客户端访问的根 URL，在端口绑定之前或没有 URL 形式时抛错。

设置 `compression: 'gzip'` 可以包装符合条件的 socket-backed 响应，而不改变 route API。客户端必须接受 gzip，且媒体类型必须可压缩或为 `multipart/form-data`；已知长度小于 `compressionThresholdBytes` 的响应保持未压缩，未知长度的流则立即符合条件。已有编码、`Cache-Control: no-transform`、range 响应、SSE（Server-Sent Events）、ZIP 与已打包的 `.gz` Worker image 均保持不变。随附 Web bundle 使用 level 1 与 1024 字节阈值；其他组合默认不压缩。

### 服务 HTTPS

`tls` 在同一地址上以 TLS 提供同一批路由：载体不会另开一个 HTTP 监听，也从不重定向。两个文件在激活期间、socket 绑定之前各读取一次，因此不可读、为空或格式错误的文件、与证书不匹配的私钥，或绑定失败都会拒绝初始化——配置错误的证书绝不会退回 HTTP。路径相对进程工作目录解析，私钥必须是无口令的 PEM，`certFile` 可以包含证书链且叶子证书在前。替换任一文件都需要重新加载；本载体既不申请也不续期证书。

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3000
    tls:
      certFile: /etc/dsh/tls/cert.pem
      keyFile: /etc/dsh/tls/key.pem
```

`ctx.webServer.protocol` 读出所绑定监听是 `'http:'` 还是 `'https:'`，因此按传输层制定请求策略（会话 Cookie 的 `Secure` 属性、来源检查）的插件只需读一个源自配置的值，无需检查 socket，也无需信任转发头。客户端仍会校验你提供的证书：本载体不附带信任库、不做 HTTP 到 HTTPS 的重定向，也不发送 HSTS 头。

### 注册路由

WebServer 事件以发起它的 WebServer 为 Cordis subject。普通监听器仅接收相同 `webServer` isolation 中的事件；`{ global: true }` 明确跳过此过滤。请求处理、页面注入和入口 URL 收集均遵循此规则。自定义发起者也必须把自己的 WebServer 实例作为 subject 传入。

`register(route)` 添加具名的 `exact`／`prefix` HTTP route，`registerUpgrade(route)` 为精确 pathname 添加 upgrade route，两者返回的 disposer 都会移除注册。同一张表内的重复路径会抛错——route 模式是组合层约定，冲突即配置错误。HTTP 匹配先在整张表中匹配精确 route，再匹配最长前缀，最后交给回退；upgrade 只做精确匹配，未命中连接直接关闭。

具名路由可以使用 `resource(request, peer?)` 代替 `handler`，将 Fetch `Request` 映射为 `Response`。准入后仅 `GET` 与 `HEAD` 可到达 resource；其他方法返回带 `Allow: GET, HEAD` 的405，不读取正文。resource 接收准入 Peer（若有）与客户端请求头；URL 将请求目标按占位 origin 解析，客户端 authority 保留在 `host` 中。响应按背压及与 handler 相同的 gzip 规则发送；`HEAD` 不发送正文，断开会中止 `request.signal` 并取消正文。`readResource(request, peer)` 使用显式准入的 Peer 在进程内分发，不检查 Cookie、Host 或 Origin，但解析出的 `deny` 返回403。它遵循 HTTP 匹配顺序，对 handler 或未认领回退返回404，对非 GET/HEAD 读取返回405；HEAD 读取不返回正文。

HTTP 请求在路由查找前经过 `webserver/request(request, response, next)`。监听器拥有响应或等待 `next()`，请求错误处理器容纳中间件异常。匹配后，HTTP 与 upgrade 路由解析 `auth`，可为固定策略或读取请求事实的同步选择器。默认 `required` 要求存活 Peer；`anonymous` 免凭据；`deny` 不分发，直接返回403。其余策略通过同步 `webserver/authorize(request, policy)` 采用首个决策。无人决策时匿名放行，认证返回503。HTTP 与 upgrade 的准入拒绝响应均携带 `Cache-Control: no-store`。Connection 提供来源检查与有序凭据验证；来源检查同样适用于匿名路由。HTTP handler 接收 `(req, res, peer?)`，upgrade 接收 `(req, socket, head, peer?)`，resource 保留已有 Peer 参数。进程内读取不触发此事件。

已准入的 upgrade 在已注册协议 handler 前经过 `webserver/upgrade(req, socket, head, peer, next)`。waterfall 携带已选定的 Peer，匿名准入可为 `undefined`；被拒绝的请求不会进入。监听器自行处理 Socket，或等待 `next()` 委派。WebServer 等待同步或异步协议 handler，并在中间件或 handler 拒绝时记录日志、销毁该 Socket。Provider 专属 Socket 限制与凭据清理属于监听器，不属于 WebServer 或 Gateway。

`webserver/entry-url(baseUrl, entries)` 根据传入的服务器基地址同步收集完整入口 URL。监听器追加 `{ label, url, open }` 入口。WebApp 在就绪后触发该事件。WebApp 拥有按序打印与首个可自动打开入口的浏览器交接。该事件不认证请求，也不改变监听器或公告地址配置。

### 回退席位

`registerFallback(handler)` 或含 `handler`/`resource` 及可选 `auth` 的对象认领未匹配请求的唯一应答方。裸 handler 同样默认采用 `required` 准入。第二次注册抛错，未认领席位返回404。随附 Web 组合由 [SPA dist 服务器](../frontend-static/README.zh.md)持有席位，选择 index 认证访问及静态资源匿名访问，并为 index 响应调用 `renderIndex`。

index 启动输入分两层，按页面所代表的 Peer 计算。`collectIndexInjections(peer)` 收集一张全新的注入表——每次调用发一次 `webserver/index-inject` 事件，把 `peer` 传给每个订阅方，订阅方推入其当前行——`renderIndex(html, peer)` 先把这些行渲染进 index.html 正文，再按注册顺序应用原始 `tapIndex(transform)` 转换。`script-preload` 行会渲染为 classic script 的提示性 preload 链接。静态部署会在启动 payload 中携带同一批行。`applyIndexTaps(html)` 只应用原始转换；它是任何行都无法表达的标记的逃生口。

### 失败时的行为

监听失败（例如 EADDRINUSE）会以绑定诊断信息拒绝插件初始化，不可用的 TLS 材料同样会拒绝它，诊断信息给出配置字段与解析后的路径，但绝不包含文件内容。handler 或 resource 抛错的 HTTP 请求会得到 400——若响应头已经发出则销毁 socket——并记录 warning；它绝不会退出进程。upgrade handler 抛错或升级 socket 出现传输错误时，会记录 warning 并销毁对应 socket。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

`WebServer` 继承 Cordis `Service`，拥有匹配、路由准入、响应交付与 index 渲染。Connection 通过事件提供来源/凭据决策，WebServer 不依赖具体认证实现。index 渲染收集新的 `webserver/index-inject` 行，渲染后执行原始转换。upgrade handler 在准入后拥有协议协商与连接内容。监听器 getter 与 `getOrigin()` 暴露配置决定的传输事实；显式 `tls: null` 表示 HTTP 监听器。

### 匹配与生命周期

`match(pathname)` 先查精确表，再遍历前缀表取最长匹配，最后走回退。激活会注册一个拥有整段获取过程的 effect——TLS 读取、明文或安全服务器、以及绑定——因此落在初始化中途的资源释放会等待该监听并在其后关闭它，而不会留下无主的监听。资源释放会启动 `close()` 与 `closeAllConnections()`，销毁所有受跟踪的升级 socket 与所有原始 TLS 连接，并仅在服务器与这些 socket 均已关闭后返回。Node 的 `closeAllConnections()` 既不包含升级 socket，也不包含握手尚未完成的 TLS socket，因此服务显式跟踪二者。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `WebServer` 服务：路由表、回退席位、index 渲染、匹配、TLS 监听、生命周期 |
| [`src/injections.ts`](src/injections.ts) | 结构化 `IndexInjection` 行与 `renderIndexInjections` 行渲染 |
| [`tests/tls-fixture.ts`](tests/tls-fixture.ts) | 为 TLS 监听测试生成的 TLS 材料；其他测试套件可物化同一套材料 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务器约定不够用时阅读以下内容：先看子系统参考，再看回退持有者，以及谁注册哪条路由背后的分层决策。

- [HTTP 服务器子系统](../../../docs/subsystems/web-server.zh.md)——路由、匹配顺序与服务器接受的配置。
- [SPA dist 服务器](../frontend-static/README.zh.md)——回退席位的随附持有者。
- [Web 配置树启动与传输分层](../../boot/app-boot/README.zh.md)——功能插件为何拥有每条路由。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-webserver)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。该 HTTP 载体只桥接浏览器与 API handler，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明服务器在何处有意保持最小。它们是当前包约束，不是任务积压。

- **不管理证书生命周期**：`tls` 只提供激活时存在的 PEM 文件——载体从不申请、续期或监视它们，并采用 Node 默认的 TLS 策略。替换证书需要重新加载。
- **凭据与来源策略需要准入监听器**——载体执行路由声明，但不自行验证凭据。无人决策时，认证路由返回503，匿名路由仍可访问；活动 Connection 监听器对两者均执行来源检查。
- **Socket 选项固定不变**：配置只选择绑定宿主与端口；在具体部署产生需求前，backlog 和其他 socket 设置仍保持内部实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

两条工作备注，均非权威结论：

- TLS 测试材料在测试时生成（`tests/tls-fixture.ts`），绝不入库：GitHub push protection 会拦截测试中的 PEM 私钥，况且该证书本就是一次性的。该助手每个进程签发一张自签名的 localhost 证书，覆盖 127.0.0.1、`::1` 与 `localhost`，并以仅属主可读的权限写入私钥。
- `selfsigned` 固定在 4.x：在 pnpm 下 5.x 会装入两份 `@peculiar/asn1-schema`，其 extension 构造器随后会让每次 `generate()` 抛错。

</details>
