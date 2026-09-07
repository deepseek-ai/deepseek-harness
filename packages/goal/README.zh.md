---
description: "goal 组地图：每会话一个持久的完成目标，以及模型工具、用户命令与自动续行，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/goal

[English](README.md) | 中文

## 概述

goal 组为 agent 会话提供一个持久的完成目标，在重启、resume（恢复）与 fork 后依然存在：goal 服务持久保存状态与生命周期，模型工具让 agent 创建和更新 goal，`/goal` 命令让用户无需模型轮次即可直接控制 goal，续行驱动器则把 active 的 goal 变成连续多轮的自动工作。goal 状态保存在会话日志中，组内没有任何独立存储。同一时刻只有一个当前 goal；goal 是状态而非调度器——自动续行是需要你刻意挂载的可选消费方。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`goal`](goal/README.zh.md) | 每会话一个持久 goal：create、edit、pause、resume、complete、block 和 clear | `ctx.goals` |
| [`tool-goal`](tool-goal/README.zh.md) | 模型工具 `get_goal`、`create_goal`、`update_goal` | 注册到 `ctx.tools` |
| [`command-goal`](command-goal/README.zh.md) | UI 命令平面中的用户 `/goal` 命令 | 注册到 `ctx.commands` |
| [`goal-round-driver`](goal-round-driver/README.zh.md) | 自动续行：把 active 的 goal 变成连续多轮 | 无服务键 |

-----

<a id="related-documentation"></a>
## 相关文档

- [goal 子系统](../../docs/subsystems/goal.zh.md)——goal 类型、持久的 `goal/change` 事件与生成的服务 API。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-goal)——模型接收的三个 goal 工具 schema。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-goal)——goal 服务的每个受支持配置字段。
- [goal 领域 Agent Note](../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md)——领域设计及其决策。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
