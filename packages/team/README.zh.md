---
description: "team 包组：子代理树的共享任务协调及其面向模型的工具。"
kind: "package-group"
---

# team/ — 共享任务协调

[English](README.md) | 中文

## 概要

Team 包让同一子代理树中的智能体共享任务归属和依赖。服务保存每个根 Session 的 Team 选择和任务板。工具插件向模型提供任务操作和协作指引。子代理创建、发现、消息和中断仍由 subagent 包族负责。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发者笔记](#dev-note)

-----

<a id="packages"></a>
## 包列表

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`agent-team/`](agent-team/README.zh.md) | 子代理树的共享任务板及持久化 Team 模式 | `ctx.agentTeams` |
| [`tool-agent-team/`](tool-agent-team/README.zh.md) | Team 模式开启时提供共享任务工具 | 注册到 `ctx.tools` |

<a id="related-documentation"></a>
## 相关文档

- [Agent Teams 子系统](../../docs/subsystems/agent-team.zh.md) — 任务类型、事件与服务 API。
- [Subagent 包](../subagent/README.zh.md) — 委派、发现与通信。

<a id="dev-note"></a>
## 开发者笔记

无。
