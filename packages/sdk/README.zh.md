---
description: "SDK 能力家族的包映射：JSON-RPC 协议格式，以及供进程外 SDK 使用的 TypeScript 客户端与服务器。"
kind: "package-group"
---

# sdk/：从另一进程驱动 Harness 运行时

[English](README.md) | 中文

## 概述

本组让另一进程驱动完整的 DeepSeek Harness 运行时：JSON-RPC 协议格式定义消息，服务插件通过 stdio 为外部客户端提供服务，TypeScript 与 Python 客户端则用具名 profile 和有序 patch 启动 `dsh`。本组没有任何包定义独立应用或创建开发者项目。SDK 客户端可以打开会话、发送提示词，并实时观察会话事件、agent 状态转换与 subagent 完成事件。TypeScript 客户端是 [Python SDK](../../python/README.zh.md) 的设计孪生，二者说同一种协议。本页是组的映射；各包 README 负责各自的包级约定。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包 README 描述你可用该包部分完成的事情。

| 包 | 职责 |
|---|---|
| [`protocol/`](protocol/README.zh.md) | 协议格式：按换行分帧的 JSON-RPC 传输，以及具名的请求、结果与通知类型 |
| [`client/`](client/README.zh.md) | TypeScript 客户端：启动运行时子进程，通过高层与协议层 API 驱动 agent 轮次 |
| [`server/`](server/README.zh.md) | `jsonrpc` 插件：通过 stdio 为进程外 SDK 客户端提供服务 |

-----

<a id="related-documentation"></a>
## 相关文档

先从 Python SDK（客户端约定的姊妹实现）开始，再看可运行应用与组边界背后的决策记录。

- [Python SDK](../../python/README.zh.md) — 说同一种协议的 Python 对侧实现，并随附捆绑运行时。
- [SDK 应用组合包](../bundle/sdk-app/README.zh.md) — 启动 JSON-RPC 服务器的 `dsh --profile sdk` 应用。
- [架构](../../docs/architecture.zh.md) — 打包后的 Python 客户端为何启动相同的具名 profile。
- [SDK 项目工具链移除](../../.agents/notes/archived/simplification/2026-08-11-remove-sdk-project-toolchain.md) — 本组为何从不创建、配置或构建开发者项目。
- [SDK subagent 提供方](../subagent/subagent-dsh-sdk/README.zh.md) — harness 内部消费 TypeScript 客户端的例子。

<a id="dev-note"></a>
## 开发备注

无。
