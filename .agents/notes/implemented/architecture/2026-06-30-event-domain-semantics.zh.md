# Agent Note: 事件域语义——会话是事实日志，agent 是实时事件通道

Status: implemented

[English](2026-06-30-event-domain-semantics.md) | 中文

## 问题

harness 通过 Cordis 事件分类体系扩展 agent loop（智能体循环）（见[微内核事件分类体系 Agent Note](2026-06-11-microkernel-event-taxonomy.zh.md)）。随着该分类体系的增长，三个事件域之间的界限变得模糊：

- `session/*` 承载持久的、事件溯源的日志（`SessionEventMap`）。
- `agent/*` 承载运行时实时信号，向插件传递 `Agent` 句柄。
- `tools/*` 承载工具注册表与执行流水线。

两个问题促使我们固定语义。第一，若干轮次/步骤边界同时作为持久的 `SessionEvent`（`turn/start`、`turn/end`、`step/start`、`step/end`）和镜像的 `agent/*` emit（`agent/turn-start`、`agent/turn-end`、`agent/step-start`、`agent/step-end`）存在。消费方对同一事实有两个真源，每次生命周期变更都必须同时更新两处。第二，钩子子系统需要一个连贯且有文档的订阅表面——插件作者（以及基于其上构建的 Claude Code / Codex 钩子桥接）必须在不阅读循环代码的情况下知道应该监听会话事件还是 agent 事件，以及原因。

这套词汇是拦截决策、持久的 `hook/*` 日志，以及 Claude Code 和 Codex 桥接的基础。

## 决策

**三个域，各司其职，以一条边界规则统一。**

- **`session/*`——持久的、可回放的事实日志。** 拥有 `SessionEventMap`；每条记录仅含 JSON（无活对象）。每次追加触发一次 `session/event` emit，加上 `session/flush` 并行持久性检查点。它同时也是实时 transcript（文本记录）源：想渲染或响应已发生事件的消费方在此订阅，因此实时渲染与回放投影共享同一路径。
- **`agent/*`——运行时实时表面。** 始终携带活的 `Agent`。拦截 waterfall（瀑布式事件）（`agent/pre-step`、`agent/request`、`agent/request-error`）负责变换、拒绝或恢复；awaited `agent/turn-stopping` 观察停止边界；瞬态 emit 报告生命周期、状态、inbox 插入、领取与丢弃、错误，以及进程本地 `agent/assistant-stream` frame。轮次和步骤边界不在此处——它们是从 `session/event` 读取的持久 Session event；Assistant stream 证据只在一个 `assistant/message` 或 `assistant/attempt` settlement 内变为持久事实，轮次中途 steering 则是持久 `user/message`。
- **`tools/*`——工具注册表与执行流水线。**

**边界规则：** 持久的、可回放的事实是 `SessionEvent`；实时拦截或瞬态/活对象信号是 `agent`/`tools` Cordis 事件。轮次或步骤边界是持久事实，因此存在于会话日志中并从 `session/event` 源读取——不会被镜像为 `agent/*` emit。

**将规则应用于边界镜像：** 全部四个边界镜像——`agent/turn-start`、`agent/turn-end`、`agent/step-start`、`agent/step-end`——被**移除**。没有生产消费方需要在边界处获取活的 `Agent`：ACP（Agent Client Protocol）桥接将其进行中的提示词与精确对应的 `session/event` `turn/start`/`turn/end` 事件对关联，其他 transcript 消费方同样从持久流派生边界。见[移除边界镜像事件 Agent Note](../../archived/simplification/2026-06-20-remove-agent-boundary-mirror-events.md)，该决策由它负责。移除 emit 也简化了循环的 `closeStep`/`closeTurn`（各只需一次 append，无需配对 emit）。

## 后果

- 循环不再 emit 任何边界镜像；`closeStep` 仅追加 `step/end`，`closeTurn` 仅追加 `turn/end`。`Session.append` 负责 post-commit observer 隔离，因此抛出异常的边界 observer 无法改变轮次结果或饿死后续消费方；事件接纳失败或内部校验失败仍会在边界进入日志之前向外抛出。
- 之前通过已移除 emit 观察边界的测试，现在观察持久的 `turn/start`/`turn/end`/`step/start`/`step/end` 会话事件——它们所锁定的行为（边界顺序、步骤计数）不变；只是读取的源移到了规范源。那些测试*抛出异常的轮次边界 emit 监听器*的用例被删除，因为该代码路径不再存在（没有 emit 可供抛出）。按照 [AGENTS.md「测试记录行为，而非黄金真相」](../../../../AGENTS.md)，行为与其测试一同迁移（或一同消亡）。
- 循环仅在 `append('step/start')` 返回后才标记步骤已打开（`stepOpen = true`）。内部分发校验在日志推入之前运行，可能在不打开步骤的情况下拒绝；post-commit `session/event` observer 的失败被隔离在 `Session.append` 内部。因此该标记精确表示已提交的、欠一个后续 `step/end` 的边界。
- 完整实现见[简化 Agent Note「停止将持久边界镜像为 agent 事件」](../../archived/simplification/2026-06-20-remove-agent-boundary-mirror-events.md)：全部四个边界镜像被移除，所有消费方从 `session/event` 读取边界。`agent/steering`（不是边界镜像）不在该 Agent Note 范围内，由其后续 Agent Note [移除 `agent/steering` 镜像 emit](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md) 单独移除——它镜像的是持久的中途 steering `user/message`。
- 生成的 Cordis 事件表面（`docs/subsystems/` 各页）不再列出镜像事件。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
