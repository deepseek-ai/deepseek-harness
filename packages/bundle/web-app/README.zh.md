---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供用户运行 dsh web 表层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

## 概述

运行 `dsh --profile web`，界面会在你的默认浏览器中打开，即可与 agent（智能体）交互式聊天。你会获得会话视图、模型与设置管理以及会话历史，背后与其他表层相同的模型访问、工具与安全默认值。该命令会打印带 token 的启动 URL；浏览器用该 token 换取签名会话 cookie，再重定向到干净的根 URL。你可以从命令行更改端口、关闭浏览器交接并允许额外主机；有意不支持绑定所有网络接口。需要浏览器中的交互式工作时选择它；`dsh-headless` 是一次性的命令行兄弟表层。

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

启动后你会看到 `dsh web:` 行，其根 URL 携带新的进程 token。除非 `--no-open` 或 SSH 会话抑制，否则默认浏览器会打开该 URL、取得签名 cookie，再重定向到干净的根页面。页面加载且你可以与 agent（智能体）对话，就说明成功了。两种可预期的失败：前端未构建时，启动会以构建提示停止（checkout 中运行 `pnpm run build`）；浏览器无法打开时，stderr 会打印不含凭据的诊断，但服务器会继续运行——请自行打开已打印的启动 URL。

### 配置

大多数用户不需要设置这些；命令行 flag 会提供给下面四个设置——`--host`、`--port` 与 `--trusted-host` 来自本次调用，`--no-open` 仅对本次调用关闭浏览器交接：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent（智能体）提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `trustedHosts` | `[]` | 允许从网络访问 GUI 的额外主机 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)是每个受支持字段及其 JSDoc 的穷尽式真源。

### LAN 访问与可信主机

默认情况下 GUI 只接受本机的连接。绑定所有网络接口的部署也会允许 LAN 内的浏览器访问，此时打印的 URL 会附带一个 LAN 地址；`--trusted-host` 在两种情况下都能添加额外主机。Host 与 Origin 检查控制可达性，token 交换则认证每个 Host API 方法与 WebSocket stream。LAN 地址只在启动时采样一次，因此之后的网络变化不会被感知——重启 GUI 以重新公告。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。请在自己的机器上打开转发后的 URL；打印出的 URL 指向远端宿主机 loopback 端点。

### 按会话的 agent 设置

每个浏览器会话都从随发行版交付的 preset（默认 `standard`）组合自己的 agent（智能体），而不是共享一套进程级工具集。你可以更改默认 preset，或在 `$DSH_HOME/.agent-presets` 下添加自己的 preset。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本组合包是一份 patch 加一个运行时粘合插件。patch 重述 base 刻意省略的表层专属值，插入仅 Web 使用的宿主行与浏览器名录，然后把 agent 层移到 preset 之后；粘合插件负责 dist 服务、信任采样、提示词段落、bash 变量与就绪宣告。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona 前缀与后缀模板、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。启动中途被释放的树不会宣告任何内容。

### LAN 信任采样

`resolveLanTrust` 在启动时只采样一次网络：loopback 绑定（`127.0.0.1`）不派生任何 LAN 地址，绑定所有网卡则会加入每个非 internal IPv4 字面量。派生字面量加上显式的 `--trusted-host` 权威标识组成 `/api` 浏览器信任栅栏，打印的 LAN URL 始终与该栅栏一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、LAN 信任采样、提示词段落、bash 变量、URL 行、浏览器交接 |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--trusted-host`、`--no-open`、`--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 之后的 agent 层 |
| — | 不发布运行时不变式伴生入口；本包只持有静态 contribution 列表，每项 contribution 都由其 registry 释放。 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist 解析、fallback 席位、提示词段落、就绪宣告 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN 信任采样 |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | 页面可达后的默认浏览器交接 |

### 不变式归属

不发布不变式伴生入口，因为每项贡献——frontend-static 子插件、提示词段落与 bash 变量注册——都会随 fiber 由 registry 释放，且每个所属 registry 的包负责该关系的不变式。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你想深入了解共享核心、浏览器重载流水线或已构建的前端时，阅读以下页面。

- [组合包包映射](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——GUI 运行其上的共享核心。
- [dsh-client-hmr](../../client/hmr/README.zh.md)——开发期间客户端插件变更如何重载。
- [frontend-static](../../host/frontend-static/README.zh.md)——已构建的前端如何被服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到什么

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（first-party 顺序 10100，位于可复用指令之后）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

源码与 Web 段落位于第一方可复用指令之后。工具与配置一致时，不同 checkout 路径或本地端口不会改变前置前缀；不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你在不常见的环境下会遇到什么——源码 checkout、SSH 会话或严格网络。它们是当前包约束，不是通用的浏览器对比或任务积压。

- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **LAN 地址只在启动时采样一次**——启动后的网卡变化不会重新公告；打印的 LAN URL 始终与采样结果一致。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——打印的 URL 指向远端宿主机 loopback 端点；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，`--host 0.0.0.0` 会在启动时被拒绝；请使用默认 loopback 主机。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
