---
description: "应用 Remote 层的包映射：类型化的 Client 到 Host 能力调用、结果与转发事件，供用户与维护者浏览该组。"
kind: "package-group"
---

# api/ — Remote API 层

[English](README.md) | 中文

## 概述

`api/` 组提供应用的 Remote 层：Client 环境可以调用运行在 Host 上的业务能力——管理目标、运行命令、查看插件清单、发现文件与会话引用——调用方式是类型化方法，可接收结果或流、在已打开的流上发送上行项，并观察转发的 Host 事件。`remotes` 决定暴露哪些能力、以及每次调用如何到达正确会话的 agent；`gateway` 在 Client 与 Host 之间承载调用及其结果。技术栈运行在应用共享的 Connection 之上；流式会话数据刻意不在其中。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

下面这些包共同提供 Remote 层；完整约定以各包 README 为准。

| 包 | 职责 | ctx key |
|---|---|---|
| [`remotes/`](remotes/README.zh.md) | 决定 Client 可以消费哪些 Host 能力与事件。 | — |
| [`gateway/`](gateway/README.zh.md) | 承载类型化一元调用、带 Client 上行的多路复用流，以及转发的 Host 事件。 | `ctx.typertGateway` / `ctx.remote` |
| [`job-controller/`](job-controller/README.zh.md) | 把一个后台任务的观测 record 流式送到 Client。 | `ctx.jobController` / `ctx.remote.job` |
| [`session-controller/`](session-controller/README.zh.md) | 拥有会话命令、历史记录流、实时控制状态与 Agent/Session 身份策略。 | `ctx.sessionController` / `ctx.remote.session` |
| [`settings-controller/`](settings-controller/README.zh.md) | 拥有 settings 域各 seam 之上的配置界面读写。 | `ctx.settingsController`、`ctx.credentialsController` / `ctx.remote.settings`、`ctx.remote.credentials` |
| [`workspace-controller/`](workspace-controller/README.zh.md) | 拥有 Workspace 变更与完整 Client Workspace 投影。 | `ctx.workspaceController` / `ctx.remote.workspace` |
| [`terminal-controller/`](terminal-controller/README.zh.md) | Session 拥有的交互式 shell、屏幕恢复和浏览器终端控制。 | `ctx.terminalController` / `ctx.remote.terminal` |
| [`workspace-files/`](workspace-files/README.zh.md) | 拥有有界的工作区文件访问——`stat`、分页 `read`、`list` 与已埋点操作的 `changes` 流——以及其上的 Client `file` 资源提供方。 | `ctx.workspaceFiles` / `ctx.remote.workspaceFiles` |

Remote 调用沿 Client → Host 方向运行在应用共享的 Connection 之上；流项沿 Host → Client 方向经 Gateway mux 传输，流的上行项则沿 Client → Host 方向走同一条逻辑流。API Gateway 拥有 Remote 传输，各控制器包分别拥有 Session、配置界面与 Workspace 行为。流式下载等不适合 Remote 调用的响应由功能包注册精确的 Connection Fetch 路由。

-----

<a id="related-documentation"></a>
## 相关文档

先读 API Gateway 参考以端到端了解 Remote 模型，再读 Typert 子系统页了解共享定义，并通过 Connection 了解物理载体。

- [API Gateway 参考](../../docs/api-gateway.zh.md)——Typert API Gateway 的现状参考：编程模型、生成流水线与运行时调用。
- [Typert 子系统参考](../../docs/subsystems/typert.zh.md)——protocol、Gateway 与消费方装配共享的公共约定。
- [Connection](../client/connection/README.zh.md)——每次 Remote 调用背后的 RPC 载体、`/api` 信任围栏与响应封装。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
