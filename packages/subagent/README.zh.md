---
description: "subagent 包组：委派 seam、其进程内与进程外后端，以及面向模型的委派工具。"
kind: "package-group"
---

# subagent/：subagent 能力家族

[English](README.md) | 中文

## 概述

subagent 组是委派能力家族：它让 agent（智能体）把任务交给子 agent，等待或继续子 agent 的工作，并让每个子 agent 随时可被发现。一个约定（`ctx.subagents`）服务任意数量的具名提供方，因此单个组合可以混合进程内子 agent（全新启动，或从父级已完成历史派生）与进程外子 agent——ACP agent、真实 Codex 或 Claude Code 安装，或经 SDK 运行的完整 Harness 运行时。面向模型的工具向 agent 公开委派、相邻 Agent 消息与列举，父级总能看到存在哪些子级、它们在线还是仅存于存储。本页是组的映射；各包 README 负责各自的包约定。

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
| [`tool-subagent-control/`](tool-subagent-control/README.zh.md) | 向模型公开相邻 Agent 消息、中断与列举 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Subagent 子系统](../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [Subagent 能力 seam](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)——委派能力家族的设计记录。
- [可续跑后台 subagent](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.zh.md)——接受后续轮次的持久子级。
- [合并后的 subagent 控制服务](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md)——后续消息、中断与列举面。

<a id="dev-note"></a>
## 开发备注

无。
