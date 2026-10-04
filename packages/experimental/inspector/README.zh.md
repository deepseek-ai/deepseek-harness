---
description: "面向 Host 与浏览器 Client Cordis 运行时的实验性 Chrome DevTools 检查，包括 Console 求值、Sources、Network 采集、Elements 树和独立于 CDP 的查询 API。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-inspector

[English](README.md) | 中文

## 概述

在 Chrome DevTools 中检查一个运行中的 dsh Host 及其浏览器 Client：Host 与 Client Console context、Host Sources 与调试、Host fetch 采集和共享 Cordis 树，全部 CDP 状态都在 Worker 中。

可选的[开发者工具组合包](../inspector-profile/README.zh.md) 同时启用 NodeJS 诊断和会话数据诊断，并开启 Host fetch 采集。Web startup 不需要也不接受 `--inspect`。

## 目录

- [使用本包](#use-this-package)
- [运行时布局](#runtime-layout)
- [配置](#configuration)
- [观测 API](#observation-api)
- [Cordis 树检查](#cordis-tree-inspection)
- [Host fetch 采集](#host-fetch-capture)
- [安全](#security)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

可信本地开发可通过 `pnpm run demo:inspector`，经普通 Web profile 显式挂载源码 overlay。Host 会打印调试链接，检查该目标需要 Chrome。fetch 采集包含密钥等敏感信息，本地调试端口允许执行任意代码。

组合包将 `experimental-inspector` 设置为 `disabled: false`，并设置 `captureFetch: true`。Host 可选的 `--inspect` 参数处理仅负责打开外部 Chrome 窗口，不控制 Inspector 是否运行。

启用此组件后，按 **Ctrl/Cmd+Shift+.** 可展开或收起整宽底部面板中的 **NodeJS 诊断**，无需选中 Session。拖动上边缘可调整面板高度，占用上方内容的可用空间；收起和切换页面时保留所选高度。聚焦分隔条后也可使用上/下方向键、Home 和 End。iframe 首次展开时加载，收起、切换 Session 或主面板时保持挂载；卸载此组件会重置前端。X 按钮和快捷键会在原打开控件仍连接时恢复其焦点。iframe 自动连接当前 Host 并打开 Console；不包含手动 Connection 面板。每个内嵌前端的 Console、Sources 和 Cordis 树只显示 Host 与嵌入它的页面所对应的 Client；打印的 `devtools://` 链接仍显示全部 Client。

Host 在相对于应用根目录的 `inspector/devtools/devtools_app.html` 路径提供镜像后的 DevTools 前端，沿用现有 Web 登录鉴权。`inspector/devtools` 前缀重定向到该入口；GET 和 HEAD 提供文件，缺失资源返回 404，其他方法返回 405。其 `cdp` WebSocket 路由鉴权同一浏览器会话，只转发到当前 Inspector 的 Worker page target。底部面板将已声明的页面 `clientSourceId` 传给入口及自动 WebSocket 端点，重连时继续选择同一逻辑 Client。没有选择参数时包含全部 Client；指定 Client 不在线时保留 Host；空值或重复参数以 400 拒绝升级。显式 `ws` 或 `wss` query 参数覆盖自动端点及其选择范围。

构建使用官方 `chrome-devtools-frontend@1.0.1638082` TypeScript 源码及根 workspace 的 Vite `8.0.16`。该 npm 快照是 Chromium 150 发布分支的祖先，不是其后续稳定版的逐字节副本。[源码配置](scripts/devtools/source.ts)与包清单共同固定版本。普通 npm 安装提供源码和工具链；构建不需要 appspot、下载或启动浏览器，也不需要提取 PAK。workspace 安装和发布包安装都不运行 DevTools 下载 hook。

[分发构建](scripts/build-devtools.ts)将 ESM 入口、共享 chunk、显式 Worker、注入脚本与运行时资源输出到 `lib/devtools`，保留原始模块相对资源 URL，包括部署子路径。CSS 文本模块、图片变量和最小英文 locale 常量替代 GN 生成输入，不修改 npm 源码。前端直接使用上游模块内的英文 UIStrings，不包含翻译文件或词条生成器，其他语言偏好回退英文。所有上游面板均保留，包括 Lighthouse。Memory 带有解析 Worker，Performance 记录 Host CPU。发布包包含构建资源、完整性清单和 Chromium license，不包含构建用 npm 源码或 Vite 依赖。

前端在构建时选择浏览器运行时适配器、排除 Node 专用传输，不使用 import map。同源连接 bootstrap 先于应用入口执行。底部面板添加 `disableLocaleInfoBar=true`，bootstrap 设置 DevTools 自己的 `disable-locale-info-bar` 偏好，不改变语言。升级前端时，需要一起调整 npm 版本和源码配置，然后重跑面板和 Worker 检查；不兼容的源码变动会使构建失败。

<a id="runtime-layout"></a>
## 运行时布局

Worker 不访问实时 Cordis 对象；共享 Host/Client collector 会在传输前把它们投影成已验证快照。Cordis 负责插件组合、注册 `ctx.inspector`、注入 bootstrap 和 dispose（资源释放）。后加载的 Client 通过已鉴权的 Host 路由获取 bootstrap。初始注入与主动获取两条路径中，bootstrap 传输或 source 建立失败均记录警告并保留连接重置后的重试；bootstrap 数据非法或服务注册失败则使启动失败。替换 source 会等待旧服务消费者清理完成，再申请新 source；卸载已激活插件会取消其未完成的 bootstrap 刷新。

Host 插件启动 Worker 并连接专用 `MessagePort`。Client 使用注入或主动获取的浏览器 source 参数，直接向 Worker 打开带鉴权的 WebSocket，不接收 DevTools URL。Chrome DevTools 连接 Worker 的 CDP WebSocket。每条 DevTools 连接在 Worker 中独占一个连接 Host 主线程的 `node:inspector.Session`，因此 Host JavaScript 暂停时仍可调试 Host。

源码树遵循这些执行环境：`client/` 与 `host/` 提供镜像的适配器 entry path，`worker/` 只包含 Worker thread orchestration 与 Chrome protocol 状态，`shared/` 包含与环境无关的 Cordis 和 network model、规范化 realm 后端接口及内部 bridge protocol。Worker 侧 Client 与 Host 适配器镜像放在 `worker/realms/` 下；其中的 Client 适配器仍然在 Worker 中执行。

Host 与 Client producer 发送内部观测记录，不发送 CDP 消息。记录包含 source generation、sequence、source 时钟时间、topic 和 JSON payload。Worker 验证每个进程或网络帧，独占 source 状态与保留历史，并把已识别 topic 转换成标准 CDP domain。

Client source 声明类型化 Runtime、Console 和只读 Sources 能力。`Runtime.enable` 只发布默认 Host execution context，并为此 DevTools 连接范围内的每个已连接 Client 发布一个 synthetic context；不列出 Node internal 和额外 VM context。选择 Client context 后，求值、属性读取、函数调用、Promise await 和对象释放都会路由到该浏览器 realm。Client Console argument 使用同一份会话本地 object table；`Debugger.enable` 发布构建后的 `lib/client.js` catalog，`Debugger.getScriptSource` 读取有界 content chunk。Source map 地址来自已加载脚本末尾的 `sourceMappingURL`，保留 combo URL 和部署前缀。Client script 断点、step 和 call frame 仍不支持；target-wide pause 与 resume 只控制 Host debugger。

Client 在 `pagehide` 时同步关闭 source，缓存页面恢复并收到 `pageshow` 后，使用同一逻辑身份重新连接。仍然存活的页面切到后台不会断开。已关闭的 generation 不会在异步操作完成后发布执行上下文或 script catalog。

两个插件端运行同一份可在浏览器中安全运行的 Cordis collector。它把可达 Context 与 Fiber 对象转换成有版本的 `CordisTreeSnapshot`；Worker 存储这份与 CDP 无关的表示，并把每个 Host 或 Client source 投影到 Elements 面板。

<a id="configuration"></a>
## 配置

Host 插件注入 `webServer` 和 `connection`，接受以下字段：

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `host` | `127.0.0.1` | Worker endpoint 监听地址；只接受 loopback |
| `port` | `9230` | Worker endpoint 起始端口；端口占用时向上递增，`0` 表示由操作系统分配 |
| `clientOrigins` | `[]` | `/ingest` 额外接受的精确浏览器 origin；loopback origin 始终允许 |
| `captureFetch` | `true` | 包装 `globalThis.fetch` 并发布之后的每次调用 |
| `maxRequestBodyBytes` | 8 MiB | 每次请求保留的 request body 前缀 |
| `maxResponseBodyBytes` | 32 MiB | 每次请求保留的 response body 前缀 |
| `maxBodyChunkBytes` | 48 KiB | base64 编码前一条 body 记录携带的原始字节数 |
| `maxJournalBytes` | 256 MiB | Worker 保留的请求与响应 body 总字节数 |
| `maxRetainedRequests` | `2000` | Worker 保留的进行中与已完成请求总数 |
| `maxSourceFrameBytes` | 128 KiB | 编码后的 source frame 上限 |
| `maxSourceRecordsPerFrame` | `128` | 每个 source batch 的记录数 |
| `maxQueuedRecords` | `2048` | 每个 producer 等待发送的记录数 |
| `maxQueuedBytes` | 16 MiB | 每个 producer 等待发送的编码字节数 |
| `startupTimeoutMs` | 10 秒 | Worker ready 截止时间 |
| `stopTimeoutMs` | 5 秒 | 强制终止前的 Worker 优雅关闭期限 |
| `clientReconnectBaseMs` | 250 ms | Client 首次重连退避上限 |
| `clientReconnectMaxMs` | 5 秒 | Client 最大重连退避上限 |
| `clientRuntimeTimeoutMs` | 30 秒 | 一次 Worker 到 Client Runtime 或 Sources 命令的截止时间 |
| `queryTimeoutMs` | 10 秒 | 一次非 CDP 语义查询的截止时间 |
| `maxClientRuntimeObjects` | `10000` | 每条 DevTools 连接保留的 Client 实时对象 handle 数 |
| `maxClientRuntimeProperties` | `2000` | 单次 Client 对象检查返回的属性描述符数 |
| `maxClientSourceBytes` | 8 MiB | 单个 Client script 或 source map 允许读取的最大编码字节数 |
| `maxCordisNodes` | `2048` | 一个 realm 快照截断前允许的 Context 与 Fiber 节点数 |
| `maxDisconnectedCordisTrees` | `8` | 作为非实时快照保留的最近断联 realm 树数量 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-inspector)是全部已接受字段及其声明的详尽来源。

Worker 监听后，Host 会记录一个 `devtools://` URL。同一个 Worker 提供 `/json`、`/json/list`、`/json/version`、`/devtools/page/<id>` target WebSocket 和 `/ingest` Client source。

<a id="observation-api"></a>
## 观测 API

两个插件端都提供同一个服务：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { InspectorJsonValue } from '@deepseek-ai/dsh-experimental-inspector'

declare const ctx: Context
declare const topic: string
declare const jsonPayload: InspectorJsonValue

ctx.inspector.publish(topic, jsonPayload)
await ctx.inspector.cordis.getTree()
```

发布操作先验证无损 JSON，再调度发送，不等待 Worker。每个 source 的队列都有上限；溢出表现为 sequence gap，绝不延迟被观察的应用操作。`cordis.getTree()` 读取 Worker 最新的 detached semantic 快照，不创建 CDP 会话，也不启用 Runtime、Debugger 或 Sources。

<a id="cordis-tree-inspection"></a>
## Cordis 树检查

Elements document 包含固定的 `<host>` 与 `<clients>` 容器。`<host>` 包含 Host root Context；`<clients>` 为每个 Client source 包含一个 `<client>`，每个 `<client>` 再包含该 realm 的根 Context。Cordis root Fiber 不显示。移除 Cordis 服务调用的 `shadow` 包装层后，其他 Fiber 都是 `fiber.parent` 的子节点，并包含唯一一个表示 `fiber.ctx` 的 Context 子节点；Fiber 只携带 `uid="<Cordis Fiber.uid>"`，Context element 不携带 attribute。只有 Context 的 `extend()`、`isolate()` 与 `intercept()` 层仍然是直接 Context 后代。

Host 与 Client 发布同一种嵌套 `CordisTreeSnapshot` 类型。Context 与 Fiber 节点携带用于 realm-local 对象查询的不透明 object 句柄；Fiber 还携带 Cordis `uid`。Worker 把这些 realm 快照组合成一棵 `{ host, clients }` inspection tree。Worker 按 source generation 分配 `BackendNodeId`；每条 DevTools 连接分配自己的 `NodeId`；`DOM.resolveNode` 请求所属 Host 或 Client Runtime 生成连接本地 `RemoteObjectId`。`DOM.requestNode` 把该 object id 映射回同一个 Elements 节点。`ctx.inspector.cordis.getTree()` 与 `DSHInspector.getCordisTree` 读取不含 routing 句柄或 CDP id 的 detached 消费方无关 tree。

节点按 DevTools 连接做深度受限下发：调用方省略 `depth` 时 `DOM.getDocument` 提供三层 document，被扣留的层级通过 `childNodeCount` 声明数量，展开时经 `DOM.requestChildNodes` 获取（`depth: -1` 取整棵子树）。重复展开只补发缺失的子节点列表，保留已有前端节点对象和已加载的深层后代。经 `DOM.performSearch`、`DOM.requestNode` 或 `DOM.pushNodesByBackendIdsToFrontend` 流出的 NodeId 会先把尚未下发的祖先层级以 `DOM.setChildNodes` 事件推送出去。

source 仍发布完整 snapshot，Worker 在通知 DevTools 前按稳定的 backend node identity 比较差异。无变化的 snapshot 不发送 DOM 事件。已知节点尚未下发的子节点列表有变化时，只发送 `DOM.childNodeCountUpdated`；展开时再获取完整的当前子节点列表。已下发的子节点列表接收节点级插入和移除事件，插入节点的载荷扣留其子树，兄弟节点重排只替换对应 parent 的 children。attribute 变化只发给已下发的节点。重新获取 document 会替换其已下发深度；`DOM.describeNode` 不会将节点挂入前端树。现有 `NodeId` 与未受影响的 Elements 展开状态保持稳定。

Client 断联时，其 Console execution context 与 live object id 会立即销毁，该项随即从 Console 上下文选择器中移除。启用断联树保留后，Elements 保留最后一棵树，并在其 `<client>` 元素上添加布尔属性 `disconnected`。重连会沿用逻辑 source id，为新的 transport generation 创建新的 synthetic CDP context id，并在完整 snapshot 替换旧树时移除该属性。属性变化通过增量事件到达，不需要刷新 DevTools。Client 把逻辑 id 保存在 `sessionStorage` 中，并通过 Web Locks 在页面存活期间独占该 id，因此刷新会复用 id，而复制出的另一个 live tab 会取得新 id。Worker 最多保留 `maxDisconnectedCordisTrees` 棵此类 snapshot；设为零会立即移除。

<a id="host-fetch-capture"></a>
## Host fetch 采集

fetch 采集默认开启，记录完整 URL、全部请求与响应 headers、请求体、响应体、状态、时间、错误和取消。它不脱敏 credential、Cookie、query value 或 payload。body 采集读取 clone；原始 fetch resolve 后，调用方立即拿到原始 Response。

配置的 body 上限限制保留量，而不选择字段：采集保留前缀并标记 truncated。`Network.getRequestPostData` 与 `Network.getResponseBody` 读取 Worker 保留的字节。`Network.streamResourceContent` 返回已缓冲的前缀，并仅为发起调用的 DevTools 连接把后续 response 字节附加到 `Network.dataReceived`，以驱动实时 Response 与 EventStream 视图。直接调用 Undici Client/Dispatcher，以及插件激活前保存的 fetch 引用，不在观察范围内。

response headers 到达后，调用方 abort 可能会终止 observer clone；已采集的字节仍可通过 `Network.getResponseBody` 读取，采集 metadata 记录错误与截断，并且 CDP 因 fetch 已返回 Response 而发送 `Network.loadingFinished`。response headers 到达前发生的 fetch rejection 会发送 `Network.loadingFailed`，其中 abort 对应 `canceled: true`。

<a id="security"></a>
## 安全

Client 选择只限制一条 DevTools 连接的 realm session、DOM 投影和诊断查询，不停止采集，也不改变共享观测 API。它是显示筛选，不是授权机制：可信调试用户可以打开不带筛选的连接，Host 求值仍拥有原有权限。

CDP target 通过 `Runtime.evaluate` 提供 Host 和已连接 Client realm 中的任意代码执行能力，Host Debugger 操作还会提供额外控制，完整 fetch 采集也包含敏感信息。因此 Worker 只接受 `127.0.0.1` 监听地址。Client ingest 还要求 Host 注入的随机 WebSocket subprotocol token；除非配置明确允许，否则拒绝非 loopback origin。CDP socket 本身不携带 token，loopback 监听是它唯一的访问控制。

<a id="model-experience"></a>
## 模型体验

无：这个仅供开发者使用的 Inspector 只观察运行时活动，不改变模型请求。

#### KV Cache 影响

无：本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Memory 和 Performance 检查 Host** — Memory 抓取 Host 堆快照，Performance 记录 Host CPU 采样。Client Runtime context 不提供浏览器堆快照或渲染轨迹。
- **同源转发运行在 Host 主线程** — 暂停 Host JavaScript 也会暂停转发。断点调试和恢复执行应使用启动时打印的 Worker 直连 DevTools 端点。
- **Client active debugging 不受支持**——Console event、Runtime 求值、RemoteObject 访问和只读 `lib/client.js` Sources 可用。Client script debugger request 返回明确的 unsupported error；target-wide pause 与 resume 只控制 Host。
- **Client Sources 只暴露 Inspector bundle**——本包不收录页面中的其他 script。
- **Client 求值使用页面 JavaScript**——页面 Content Security Policy 可能阻止动态求值；synthetic context 不提供 DevTools command-line helper 或原生 REPL 声明语义。
- **Client 身份仲裁依赖 Web Locks**——缺少该 API 的浏览器仍会通过 `sessionStorage` 保持重连与刷新身份，但无法区分从同一存储状态复制出的两个同时存活 tab。
- **fetch 拦截范围是 `globalThis.fetch`**——直接调用 Undici API，以及激活前保存的 fetch 引用不会被观察。
- **body clone 有运行成本**——完整采集会 tee 请求与响应流，直至达到配置上限，可能增加内存与 I/O 压力。保留 body 的上限不包含流 tee 内部的缓冲，包括来源提供的超大 chunk，或为读取较慢的应用分支排队的数据。
- **不自动重启 Worker**——Worker 意外退出会使当前 Inspector 实例失败；生命周期恢复留待后续改动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
