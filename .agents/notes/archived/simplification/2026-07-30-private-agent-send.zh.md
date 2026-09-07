# Agent Note: 将 agent 路由保留为私有实现

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-private-agent-send.md) | 中文

## 问题

公开的 `Agent.send()` 方法暴露了具体循环实现的路由矩阵，但生产调用方只使用语义明确的 `followup()`、`steer()` 和 `inject()` 操作。第四种组合，即 `next-turn` 配合 `wakeup: false`，除测试外没有消费方。将这项潜在能力保留为公开接口，还会迫使其他 `Agent` 实现和测试替身接受实现层的路由策略。

## 决策

`Agent` 将 `followup()`、`steer()` 和 `inject()` 作为完整的交付约定公开。`ReactLoopAgent` 保留私有的 `send()` 辅助方法，供这三个方法共用路由机制；`dsh-agent` 不再导出 `SendTarget` 和 `SendOptions`。

公开接口无法在不唤醒驱动器的情况下让一个轮次入队。`followup()` 始终请求执行，`steer()` 请求最近的步骤，`inject()` 则提供面向模型的上下文而不请求执行。本决策部分取代[统一交付决策](../architecture/2026-07-22-unified-send-and-coalesced-user-messages.zh.md)中关于公开接口的内容，同时保留其内部路由与统一的 `user/message` 表示。

## 曾考虑的替代方案

**让路由矩阵保持公开。** 这会保留未使用的无唤醒排队组合，但也会暴露机制而非调用方意图，并要求每个替代驱动器都支持该机制。

**添加公开的无唤醒排队方法。** 使用具名方法会比原始路由标志更清晰，但目前没有生产工作流需要让工作持续处于等待状态，直到无关的交付将其唤醒。

## 后果

插件从三种语义操作中选择，不再自行构造路由选项。其他驱动器和结构型测试替身只需实现更小的约定，Cordis API 目录也不再列出 `send`、`SendTarget` 或 `SendOptions`。

只有出现明确的消费方并定义显式的生命周期语义后，才能恢复已移除的无唤醒排队能力。`cancel({ keepInbox: true })` 仍会保留已通过受支持交付路径进入待处理状态的工作。
