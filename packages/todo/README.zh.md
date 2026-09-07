---
description: "todo 组地图：基于会话日志的模型侧 todo_write 工具，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/todo

[English](README.md) | 中文

## 概述

todo 组为 agent 提供可用于规划的会话级任务列表：添加任务、标记进行中、逐项完成，同一份列表跨轮次、跨重新打开的会话持续存在。它只包含一个产品包，提供 `todo_write` 工具；列表属于创建它的 agent 会话，每次更新都会整体替换。交互式宿主会从列表展示当前计划，组本身不附带任何 UI。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-todo`](tool-todo/README.zh.md) | 让 agent 维护会话任务列表：规划任务、更新状态、跟踪进度 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Todo 子系统](../../docs/subsystems/todo.zh.md)——`todo/write` 事件载荷、归属规则与 `TodoItem`。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)——模型接收的 `todo_write` schema。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-tool-todo)——每个受支持配置字段。
- [todo_write 工具 Agent Note](../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md)——原始设计及其备选方案。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
