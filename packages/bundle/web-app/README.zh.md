---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供运行 dsh web 表层的用户使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

桌面埋点遵循[产品采集策略](../../client/product-analytics/README.zh.md)及其动态应用配置，不包含 Web 使用情况。

桌面埋点每 30 秒调度未满批次，exporter 超时为 15 秒，processor 超时为 20 秒。退出时允许 2 秒排空，随后取消待完成的请求和重试等待，避免埋点阻止 Host 退出。尚未发送完成的事件可能丢失。

## 概述

运行 `dsh --profile web`，获得浏览器内的聊天、模型与设置管理以及会话历史，并与其他 dsh 表层共用同一套模型访问、工具与安全默认值。启动时会打印带 token 的 URL，通常还会在默认浏览器中打开；SSH 会话和 `--no-open` 需要手动打开。你可以更改端口、允许额外 authority、绑定一个具体的本机 IP，并用自己提供的证书直接提供 HTTPS；通配地址会被拒绝。跨机访问使用剥离前缀代理后公告的 HTTP(S) URL、监听器 TLS，或非 loopback 绑定上的明文 HTTP。一次性的命令行任务应使用 headless 配置。

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

启动 GUI、打开浏览器，然后开始与 agent（智能体）对话。flag 用于微调本次调用。

### 启动 Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

启动后你会看到 `dsh web:` 行，其根 URL 携带新的进程 token。除非 `--no-open` 或 SSH 会话抑制，否则默认浏览器会打开该 URL、取得签名 cookie，再重定向到不含认证参数的同一目录。页面加载且你可以与 agent 对话，就说明成功了。两种可预期的失败：前端未构建时，启动会以构建提示停止（checkout 中运行 `pnpm run build`）；浏览器无法打开时，stderr 会打印不含凭据的诊断，但服务器会继续运行——请自行打开已打印的启动 URL。

**设置 → 模型**显示 **DeepSeek**，使用 `DEEPSEEK_API_KEY`。默认模型为 `deepseek-official` / `deepseek-flash`（DeepSeek-V4.1-Flash）。[DeepSeek 插件](../../llm/llm-deepseek/README.zh.md#endpoint-and-wire-format)使用 Messages API。

已保存的模型选择覆盖组合默认值。设置卡接受兼容 Messages 的 API 地址与凭据引用。

### 配置

`--host` 与 `--port` 配置监听器；`--tls-cert` 与 `--tls-key` 让它直接提供 HTTPS；`--public-url` 指定 GUI 在剥离前缀的代理之后对外公告的公开 HTTP(S) 根，`--trusted-host` 则添加更多被接受的 authority。这些都在[监听、信任与公开部署](#public-deployments)中说明，而这些 flag 设置的 `tls` 字段记录在[载体的配置](../../../docs/subsystems/web-server.zh.md#config)中：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent 提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `publicUrl` | 未设置 | 对外公告的 HTTP(S) 应用根；否则公告绑定地址 URL |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)列出了本运行时插件接受的字段及其 JSDoc。随发行版交付的组合插入 `schedule` 服务行与 `ui-schedule` 任务页面行，时钟读数与四个提醒工具则属于 `standard`、`cordis` 与 `ptc` 三个 preset。这三个 preset 的 `tool-subagent` 与 `tool-subagent-fork` 两行都 deny 这四个工具，因此被委派子 agent 的作用域不会列出它们。

<a id="public-deployments"></a>
### 监听、信任与公开部署

默认情况下 GUI 只监听 loopback，只接受本机的连接。只有 `--host` 会改变监听器：它接受一个具体的本机 IPv4 或 IPv6 地址，不接受通配地址。未启用 TLS 的非 loopback 监听器提供明文 HTTP，并在启动时警告，即使前置 HTTPS 的 `--public-url` 也不例外。Host/Origin 栅栏接受绑定 IP 本身；其他非 loopback authority 需要 `--trusted-host`，因此远端浏览器要么经由剥离前缀的代理访问 GUI，要么通过以可信主机名呈现的端口转发客户端访问。启动 token 交换与签名会话 cookie 认证每个 API 方法与 WebSocket 流。

同时传入 `--tls-cert` 与 `--tls-key`，监听器便以 HTTPS 而非明文 HTTP 提供服务。两者各指定一个相对进程工作目录解析的文件：证书文件包含完整证书链，密钥文件为不带口令的 PEM 私钥。它们属于同一个设置——只提供一个会报用法错误，两个都不提供则保持明文 HTTP 默认值。文件缺失、不可读、为空，或不是有效的证书与密钥对时启动失败；绝不回退到 HTTP。监听器运行期间不会重新读取这些材料，因此更换证书需要重新加载监听器或重启进程。DSH 不签发、不续期也不监视任何证书：没有 ACME 客户端、没有自签名兜底，也没有重定向监听器。浏览器使用自己的信任库与主机名匹配，因此浏览器不信任的证书，或其 subject alternative name 未覆盖你所访问 authority 的证书，会在页面加载前失败。默认端口仍为 3080，且 `--tls-cert`/`--tls-key` 不跟随 `--public-url`：监听器的证书覆盖浏览器实际访问的 authority。TLS 不改变授权模型：Connection 仍认证每个请求并仍校验 Host/Origin，且只要接收请求的监听器提供 HTTPS，它所签发的会话 cookie 就带 `Secure`。

容器可以绑定其 Pod 地址，并公告前置的 ingress：

```sh
dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example
```

`hostname -i` 可能列出多个地址；`--host` 只接受一个，因此命令取第一个。`fe80::1%eth0` 这样的 zone ID 不能出现在 URL 中，因此公告根会剥离多余的 loopback zone，而非 loopback zone 则要求显式提供 `--public-url`。

未设置 `--public-url` 时，`::ffff:127.0.0.1` 这样的 mapped IPv6 回环绑定会公告其 IPv4 形式 `127.0.0.1`，让浏览器将其识别为本地可信来源。监听器仍使用配置的绑定地址。点分四段式的 IPv6 尾部表示该地址自身的低 32 位，与 `listen` 的读法完全一致：`::0.0.0.1` 属于 IPv6 回环并公告 `[::1]`，而 `::127.0.0.1` 是非回环地址，并非 IPv4 回环。

`--public-url` 公告浏览器使用的 HTTP(S) 根——打印与打开的启动 URL、`DSH_WEB_URL` 与 web 表层定位。公告不授予任何信任：浏览器可见的 authority 还必须用 `--trusted-host` 点名。该 flag 不配置监听器、路由或 cookie 作用域，因为外部链路归代理所有：[在反向代理之后发布 Web UI](../../../docs/user/guide/public-deployments.zh.md)列出了这样的部署必须提供什么。

无论是公告 URL 还是浏览器信任栅栏都不保护端口本身，因此请把端口限制在可信代理或网络内。

打印的 URL 包含进程凭据，只应与预期用户分享。`printUrl: false` 无论是否配置 `--public-url` 都会抑制该行，凭据也绝不会出现在模型上下文或 `DSH_WEB_URL` 中。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。没有公告根时，打印的 URL 指向远端宿主机的绑定地址端点——绑定 loopback 时即 loopback——你通过自己的转发地址访问它。配置了 `--public-url` 时，打印的 URL 是带认证的公告根；浏览器交接仍被抑制，因为在远端宿主机上打开浏览器无法到达你的屏幕。

### 按会话的 agent 设置

每个浏览器会话选择一个随发行版交付的 preset（默认 `standard`）。Agent 预设设置页可更改默认项并编辑预设的子插件；保存结果持久化到 `$DSH_HOME/profiles/web/cordis.patch.yml`。只有 Host 提供可编辑的 profile 时，Creator 的插件管理工具才会启用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

此 bundle 由一层五个文件的补丁和一个运行时胶水插件组成：`cordis.patch.yml` 承载宿主行和 preset 注册表，每个 `presets/<id>.patch.yml` 插入一条随发行版交付的 preset 声明，按 `dsh.bundle.patch` 列出的顺序应用。存储栈与投影缓存来自 `dsh-base`；Web 叠加层的工作区和消息反馈条目消费共享的 `storageDomain` 服务。补丁重述 base 有意省略的界面专用值，插入 Web 专用宿主条目和浏览器插件列表，再将 Agent 层移到预设后面。胶水插件负责 dist 服务、公告应用 URL、明文 HTTP 暴露警告、提示词段落、bash 变量和就绪通知。`office-to-pdf` 条目为宿主消费者挂载一个延迟创建引擎的 [Office 转换提供方](../../document/office-to-pdf/README.zh.md)，使用此 bundle 的 Desktop 组合也共享该提供方。 转换服务的 Remote 方法负责预览读取授权，Document Preview 负责 Office 查看器和客户端缓存。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona 前缀模板、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。`webserver`、`web-runtime` 与 `connection` 行都注入 `webStartup` 提供方并直接读取本次调用的取值；Connection 的被接受 authority 全部来自 `ctx.webStartup.trustedHosts`，Host/Origin 栅栏则独立于该列表接受监听器的绑定 IP。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 公告应用 URL

启动显示与浏览器交接接收附带启动 token 的公告根；web 表层提示词与 `DSH_WEB_URL` 接收不含凭据的形式。根本身由[监听、信任与公开部署](#public-deployments)定义。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算、通过 required 启动检查且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。此时 client combo JavaScript 和 source map 仍未物化。可选插件失败不会阻止就绪宣告；required 启动失败或启动中途被释放的树不会宣告任何内容。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、公告应用 URL、提示词段落、bash 变量、URL 行、浏览器交接 |
| [`src/public-url.ts`](src/public-url.ts) | 公告根的校验与尾斜杠归一化；供本地导入的叶子模块，不属于包 API |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--tls-cert`、`--tls-key`、`--public-url`、`--trusted-host`、`--no-open`、`--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 注册表 |
| [`presets/`](presets) | 每个随发行版交付的 preset（`standard`、`ptc`、`minimal`、`cordis`）各一条 `@deepseek-ai/dsh-agent-preset` 声明，各自一个补丁文件 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist index 锚定、公告 URL 发布与警告、提示词段落、就绪宣告发布 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/public-url.spec.ts`](tests/public-url.spec.ts) | 公告根的解析与归一化 |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | 页面可达后的默认浏览器交接 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你想深入了解共享核心、浏览器重载流水线或已构建的前端时，阅读以下页面。

- [组合包索引](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——GUI 运行其上的共享核心。
- [dsh-client-hmr](../../client/hmr/README.zh.md)——开发期间客户端插件变更如何重载。
- [frontend-static](../../host/frontend-static/README.zh.md)——已构建的前端如何被服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到什么

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（first-party 顺序 10100，位于可复用指令之后）则向模型说明 GUI：公告应用 URL（定义见上文「监听、信任与公开部署」）、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

源码与 Web 段落位于第一方可复用指令之后。工具与配置一致时，不同 checkout 路径或应用 URL 不会改变前置前缀；不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你在不常见的环境下会遇到什么——源码 checkout、SSH 会话或严格网络。它们是当前包约束，不是通用的浏览器对比或任务积压。

- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **TLS 需自行启用且不代管**——只有传入 `--tls-cert` 与 `--tls-key`（完整证书链与不带口令的密钥）时监听器才提供 HTTPS；DSH 从不获取、续期或监视证书，更换文件需要重新加载监听器或重启进程。浏览器必须信任该证书，其名称必须覆盖你所访问的 authority，且证书与 `--public-url` 相互独立。
- **未启用 TLS 时外部链路是明文 HTTP**——请用终止 TLS 的代理保护它，不要在不受信任的网络上发送启动 URL。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——没有公告根时，打印的 URL 指向远端宿主机的绑定地址；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，通配 `--host`（含 Linux 视为 IPv4 any 的 IPv4-mapped 形式）会在启动时被拒绝；请改为绑定本机某个接口的一个具体 IPv4 或 IPv6 地址。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

Web 组合包含账号 Remote 控制器和账号设置页面。
