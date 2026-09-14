---
description: "subagent 包组：委派 seam、其进程内与进程外后端，以及面向模型的委派工具。"
kind: "package-group"
---

# subagent/：subagent 能力家族

[English](README.md) | 中文

## 概述

subagent 包家族让 agent（智能体）将任务委派给子 agent、继续其工作，并发现自己创建的每个子级。隔离工作可选择全新的进程内子级；需要既有对话时可选择带父级历史的进程内子级；也可选择由 ACP（Agent Client Protocol）、Codex、Claude Code 或另一 Harness 运行时支持的进程外子级。面向模型的工具还让 agent 能够向相邻 agent 发送消息、中断工作并列出子级状态。无论子级正在运行还是已存储，父级都能看到它；各包 README 说明各提供方特定的设置与限制。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`subagent/`](subagent/README.zh.md) | 定义委派服务：提供方注册表、一次性运行、可继续子级与发现 | `ctx.subagents` |
| [`subagent-in-process-driver/`](subagent-in-process-driver/README.zh.md) | 提供共享的进程内运行驱动器 | 无 |
| [`subagent-spawn-in-process/`](subagent-spawn-in-process/README.zh.md) | 运行全新的进程内子 agent | 注册到 `ctx.subagents` |
| [`subagent-fork-in-process/`](subagent-fork-in-process/README.zh.md) | 运行从父级已完成历史派生的进程内子 agent | 注册到 `ctx.subagents` |
| [`subagent-acp/`](subagent-acp/README.zh.md) | 经 Agent Client Protocol 运行进程外子 agent | 注册到 `ctx.subagents` |
| [`subagent-codex/`](subagent-codex/README.zh.md) | 经官方 app-server 协议运行真实 Codex 子 agent | 注册到 `ctx.subagents` |
| [`subagent-claude-code/`](subagent-claude-code/README.zh.md) | 经官方 Agent SDK 运行真实 Claude Code 子 agent | 注册到 `ctx.subagents` |
| [`subagent-dsh-sdk/`](subagent-dsh-sdk/README.zh.md) | 经 TypeScript SDK 运行进程外 Harness 子 agent | 注册到 `ctx.subagents` |
| [`tool-subagent/`](tool-subagent/README.zh.md) | 向模型公开委派 | 注册到 `ctx.tools` |
| [`tool-subagent-control/`](tool-subagent-control/README.zh.md) | 向模型提供向相邻 agent 发送消息、中断工作和列出子级状态的操作 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Subagent 子系统](../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [Subagent 能力 seam](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)——委派能力家族的设计记录。
- [可继续的 subagent](../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)——接受后续轮次的持久子级。
- [tool-subagent-control README](tool-subagent-control/README.zh.md)——后续消息、中断与列举接口。

<a id="dev-note"></a>
## 开发备注

无。
