# Agent Note: 停止将持久化边界镜像为 agent 事件

Status: implemented
Archived: 2026-09-04

[English](2026-06-20-remove-agent-boundary-mirror-events.md) | 中文

## 问题

循环在 `SessionEvent` 中记录规范 transcript（文本记录），同时还发出一组并行的实时 `agent/*` 边界镜像事件：`agent/turn-start`、`agent/turn-end`、`agent/step-start` 和 `agent/step-end`。这些镜像迫使消费方在同一持久事实的两个真源之间做选择。ACP（Agent Client Protocol）已经为提示词结算和已提交输出选择会话日志，因为它是唯一持久、可重放的记录；消费实时镜像需要把它的时序与日志中已经存储的边界进行调和。stdio UI 是唯一仍从镜像事件渲染轮次边界的生产环境消费方；它已经从 `session/event` 渲染工具调用和工具结果。

这种重复并非零成本。每次生命周期变更都需要同时更新会话事件、镜像事件、文档、不变式、测试和快照预期。重复的边界事件还使失败事件的先后关系变得微妙：一个轮次可能在实时 `agent/turn-end` 监听器运行之前就已被持久化关闭，因此边界之后的监听器失败在日志中已没有合法位置可以插入，只能带外上报。

## 决策

将 `session/event` 作为唯一的实时边界/transcript 流。需要渲染轮次、工具调用、工具结果、助手消息和持久化边界的消费方统一订阅 `session/event`，从持久化层使用的同一套事件词汇中派生 UI。

四个持久边界镜像——`agent/turn-start`、`agent/turn-end`、`agent/step-start`、`agent/step-end`——已从 agent（智能体）事件分类体系中移除。希望在边界处取得 agent handle 的 UI 会保留来自 `agent/created`/`agent/disposed` 的实时目标对象，并直接比较其会话；`dsh-ui-stdio` 据此为应用拥有的 agent 标记 `[main turn N]` 头部，其他会话则渲染其持久 id。规范记录仍是事件溯源会话日志。

步骤镜像（完全没有消费方）最先在[事件域语义 Agent Note](../architecture/2026-06-30-event-domain-semantics.zh.md) 中移除；该 Agent Note 当时以 stdio UI 需要在轮次边界取得 `Agent` handle 为由，保留了轮次镜像。本决策完成余下工作：`dsh-ui-stdio` 是可随时丢弃的测试 REPL，其渲染可以自由变化，因此「ui-stdio 需要它」并不是保留镜像的理由——它读取 `session/event`，只保留自己的实时目标对象。

## 范围：移除什么、不移除什么

已移除（持久边界镜像——每项都以会话日志为权威）：`agent/turn-start`、`agent/turn-end`、`agent/step-start`、`agent/step-end`。

保留——不是持久边界镜像，因此不在本决策范围内：

- `agent/steering`——不是边界，因此不在本决策范围内。它镜像持久的 `steering/message` 控制记录，而非边界，后来由自己的后续决策移除：[移除 `agent/steering` 镜像 emit](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md)。
- `agent/stream-chunk`——实时 token 流。不在本决策范围内（它镜像持久的 `assistant/chunk`，而非边界），后来由自己的后续决策移除：[停止将 token 流镜像为 agent 事件](../../archived/simplification/2026-07-02-remove-stream-chunk-mirror.md)。
- `agent/created`、`agent/disposed`、`agent/status`、`agent/error`、`agent/queued`——不属于 transcript 数据的生命周期/控制事件。尤其是 `agent/queued`，它是在任何持久事件存在之前触发的收件箱确认（取消的排队工作可能永远不会进入日志），所以有意只保留为实时事件。

## 曾考虑的替代方案

- **将 `agent/steering` 一并移除**——原始提案的范围；因超出范围而被排除：它镜像持久的 `steering/message` 控制记录，而非边界，后来由[自己的决策](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md)移除（`agent/stream-chunk` 也由[流分片镜像 Agent Note](../../archived/simplification/2026-07-02-remove-stream-chunk-mirror.md) 移除）。
- **为 stdio UI 保留轮次镜像**——[事件域语义 Agent Note](../architecture/2026-06-30-event-domain-semantics.zh.md) 的原始立场；在此否决，因为 `dsh-ui-stdio` 是可随时丢弃的测试 REPL，而非承载关键约束的消费方，并且它改为根据 `session/event` 加自己的实时目标对象渲染边界。

## 后果

插件不能再通过便捷的、以 `Agent` 为首个参数的事件观察轮次/步骤边界。它需要订阅 `session/event`；如果需要实时对象，则通过 `ctx.agents` 查找共享 id 对应的对象，或保留自己已经拥有的对象。这是可以接受的取舍：边界消费方不应依赖可能与持久日志发生漂移的第二个事件源。
