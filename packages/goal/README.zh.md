---
description: "goal 组地图：每会话一个持久的完成目标，以及模型工具、用户命令与自动续行，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/goal

[English](README.md) | 中文

## 概述

goal 组让一个 agent（智能体）会话在重启、恢复和 fork 后继续追求一个持久的完成目标。agent 可以创建和更新该目标，用户也可以用 `/goal` 直接检查或控制它，而不消耗模型轮次。可选的续行包可以让进行中的工作连续执行多个 Round。每个会话只有一个当前目标，该目标记录完成状态而不调度工作；因此，自动续行必须单独启用。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`goal`](goal/README.zh.md) | 每个会话一个持久目标：创建、编辑、暂停、恢复、完成、阻塞和清除 | `ctx.goals` |
| [`tool-goal`](tool-goal/README.zh.md) | 模型工具 `get_goal`、`create_goal`、`update_goal` | 注册到 `ctx.tools` |
| [`command-goal`](command-goal/README.zh.md) | UI 命令平面中的用户 `/goal` 命令 | 注册到 `ctx.commands` |
| [`goal-round-driver`](goal-round-driver/README.zh.md) | 自动续行：把进行中的目标变成连续的 Round | 无服务键 |

-----

<a id="related-documentation"></a>
## 相关文档

- [目标子系统](../../docs/subsystems/goal.zh.md)——目标类型、持久的 `goal/change` 事件与生成的服务 API。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-goal)——模型接收的三个目标工具 schema。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-goal)——目标服务的每个受支持配置字段。
- [目标领域 Agent Note](../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md)——领域设计及其决策。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
