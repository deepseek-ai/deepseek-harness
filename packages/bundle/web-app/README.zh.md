---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供运行 dsh web 表层的用户使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

桌面埋点遵循[产品采集策略](../../client/product-analytics/README.zh.md)及其动态应用配置，不包含 Web 使用情况。

桌面埋点每 30 秒调度未满批次，exporter 超时为 15 秒，processor 超时为 20 秒。退出时允许 2 秒排空，随后取消待完成的请求和重试等待，避免埋点阻止 Host 退出。尚未发送完成的事件可能丢失。

## 概述

运行 `dsh --profile web`，获得浏览器内的聊天、模型与设置管理以及会话历史，并与其他 dsh 表层共用同一套模型访问、工具与安全默认值。启动时会打印带 token 的 URL，通常还会在默认浏览器中打开；SSH 会话和 `--no-open` 需要手动打开。你可以更改端口并允许额外主机，但不能绑定所有网络接口。跨机访问支持在剥离前缀的代理之后公告一个公开的 HTTP(S) URL。一次性的命令行任务应使用 `dsh-headless`。

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

**设置 → 模型**显示 **DeepSeek**，使用 `DEEPSEEK_API_KEY`。默认模型为 `deepseek-official` / `deepseek-flash`（DeepSeek-V41-Flash）。[DeepSeek 插件](../../llm/llm-deepseek/README.zh.md#endpoint-and-wire-format)使用 Messages API。

已保存的模型选择覆盖组合默认值。设置卡接受兼容 Messages 的 API 地址与凭据引用。

### 配置

`--host` 与 `--port` 配置监听器；`--public-url` 指定 GUI 在剥离前缀的代理之后对外公告的公开 HTTP(S) 根，`--trusted-host` 则添加更多被接受的 authority。两者都在[监听、信任与公开部署](#public-deployments)中说明：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent 提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `publicUrl` | 未设置 | 对外公告的 HTTP(S) 应用根；否则公告监听器的 loopback URL |
| `trustedHosts` | `[]` | 允许从网络访问 GUI 的额外主机 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)列出了本运行时插件接受的字段及其 JSDoc。随发行版交付的组合插入 `schedule` 服务行与 `ui-schedule` 任务页面行，时钟读数与四个提醒工具则属于 `standard`、`cordis` 与 `ptc` 三个 preset。这三个 preset 的 `tool-subagent` 与 `tool-subagent-fork` 两行都 deny 这四个工具，因此被委派子 agent 的作用域不会列出它们。

<a id="public-deployments"></a>
### 监听、信任与公开部署

默认情况下 GUI 只在 loopback 上监听，只接受本机的连接；可重复的 `--trusted-host` 会添加其 Host/Origin 栅栏接受的 authority，因此远端浏览器要么经由剥离前缀的代理访问，要么通过以可信主机名呈现的端口转发客户端访问。

`--public-url` 公告浏览器使用的 HTTP(S) 根——打印与打开的启动 URL、`DSH_WEB_URL` 与 web 表层定位。公告不授予任何信任：浏览器可见的 authority 还必须用 `--trusted-host` 点名。该 flag 不配置监听器、路由或 cookie 作用域，因为外部链路归代理所有：[在反向代理之后发布 Web UI](../../../docs/user/guide/public-deployments.zh.md)列出了这样的部署必须提供什么。

打印的 URL 包含进程凭据，只应与预期用户分享；`printUrl: false` 无论是否配置 `--public-url` 都会抑制该行。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。没有公告根时，打印的 URL 指向远端宿主机 loopback 端点，你通过自己的转发地址访问它。配置了 `--public-url` 时，打印的 URL 是带认证的公告根；浏览器交接仍被抑制，因为在远端宿主机上打开浏览器无法到达你的屏幕。

### 按会话的 agent 设置

每个浏览器会话选择一个随发行版交付的 preset（默认 `standard`）。Agent 预设设置页可更改默认项并编辑预设的子插件；保存结果持久化到 `$DSH_HOME/profiles/web/cordis.patch.yml`。只有 Host 提供可编辑的 profile 时，Creator 的插件管理工具才会启用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

此 bundle 由一层五个文件的补丁和一个运行时胶水插件组成：`cordis.patch.yml` 承载宿主行和 preset 注册表，每个 `presets/<id>.patch.yml` 插入一条随发行版交付的 preset 声明，按 `dsh.bundle.patch` 列出的顺序应用。存储栈与投影缓存来自 `dsh-base`；Web 叠加层的工作区和消息反馈条目消费共享的 `storageDomain` 服务。补丁重述 base 有意省略的界面专用值，插入 Web 专用宿主条目和浏览器插件列表，再将 Agent 层移到预设后面。胶水插件负责 dist 服务、公告应用 URL、信任采样、提示词段落、bash 变量和就绪通知。`office-to-pdf` 条目为宿主消费者挂载一个延迟创建引擎的 [Office 转换提供方](../../document/office-to-pdf/README.zh.md)，使用此 bundle 的 Desktop 组合也共享该提供方。 转换服务的 Remote 方法负责预览读取授权，Document Preview 负责 Office 查看器和客户端缓存。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona 前缀与后缀模板、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。`webserver` 与 `web-runtime` 行注入 `webStartup` 提供方并直接读取本次调用的取值；`connection` 行则改为读取 web-runtime 行发布的、与绑定相关的 `webRuntime` 值，即该提供方的 authority 加上全接口绑定的 LAN 字面量。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 公告应用 URL

启动显示与浏览器交接接收附带启动 token 的公告根；web 表层提示词与 `DSH_WEB_URL` 接收不含凭据的形式。根本身由[监听、信任与公开部署](#public-deployments)定义。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算、通过 required 启动检查且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。此时 client combo JavaScript 和 source map 仍未物化。可选插件失败不会阻止就绪宣告；required 启动失败或启动中途被释放的树不会宣告任何内容。

### LAN 信任采样

`resolveLanTrust` 在启动时只采样一次网络：loopback 绑定（`127.0.0.1`）不派生任何 LAN 地址，绑定所有网卡则会加入每个非 internal IPv4 字面量。派生字面量加上显式的 `--trusted-host` 权威标识组成 `/api` 浏览器信任栅栏，打印的 LAN URL 始终与该栅栏一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、公告应用 URL、LAN 信任采样、提示词段落、bash 变量、URL 行、浏览器交接 |
| [`src/public-url.ts`](src/public-url.ts) | 公告根的校验与尾斜杠归一化；供本地导入的叶子模块，不属于包 API |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--public-url`、`--trusted-host`、`--no-open`、`--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 注册表 |
| [`presets/`](presets) | 每个随发行版交付的 preset（`standard`、`ptc`、`minimal`、`cordis`）各一条 `@deepseek-ai/dsh-agent-preset` 声明，各自一个补丁文件 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist 解析、回退席位、提示词段落、就绪宣告、公告 URL 发布 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/public-url.spec.ts`](tests/public-url.spec.ts) | 公告根的解析与归一化 |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN 信任采样 |
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
- **监听器不提供 TLS**——请用终止 TLS 的代理保护外部链路；HTTP 公告根会以明文发送凭据。
- **LAN 地址只在启动时采样一次**——启动后的网卡变化不会重新公告；打印的 LAN URL 始终与采样结果一致。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——没有公告根时，打印的 URL 指向远端宿主机 loopback 端点；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，`--host 0.0.0.0` 会在启动时被拒绝；请使用默认 loopback 主机。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

Web 组合包含账号 Remote 控制器和账号设置页面。
