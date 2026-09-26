# Agent Note: 回放 Messages 用户输入中的助手块

Status: implemented

[English](2026-09-18-messages-input-history-compatibility.md) | 中文

## 问题

已保存的子 Agent 结算通知可能在父级用户消息中包含子级推理和工具调用。Chat Completions 与 pi-ai 会在用户输入中省略这些块，而 Messages 拒绝它们会阻断包含相同历史的所有后续请求。[仅生成文本的结算通知生产方](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)可以避免新通知携带这些块，但无法修复已经记录的消息。

## 决策

[Messages 序列化器](../../../../packages/llm/llm-deepseek/src/serialize.ts)省略用户与工具结果输入中的 `reasoning` 和 `tool-call` 块。这两类块的处理与 Chat Completions、pi-ai 一致，不改变 Session 记录，也不把子级推理转换成父级用户文本。[提供方 README](../../../../packages/llm/llm-deepseek/README.zh.md#model-experience)统一说明输入规则，包括空用户消息、空工具结果，以及对其他不支持块的拒绝。

这部分取代了结算决策对序列化器容错的拒绝，以及 [Messages 适配器决策](../feature/2026-09-07-deepseek-messages-adapter.zh.md)中的输入拒绝规则。通知构建仍为每种父级提供方投影子级的非空文本。子级的规范输出以及普通助手推理和工具调用仍可供现有消费者使用。省略依据是输入角色和块类型，而不是通知来源或创建日期，因此也适用于新提供的用户和工具结果内容。

## 考虑过的替代方案

**只修复生产方。** 新通知可以表示，但已保存的通知仍会阻断协议切换和会话续接。

**改写 Session 历史或把推理压平为用户文本。** 改写会移除原始证据；压平会把子级推理作为父级输入发送。只在请求中省略可以保留持久化记录和现有输入语义。

**忽略所有不支持的块。** 此处没有定义未知插件内容的 Messages 表示方式。兼容两种已知助手块类型并不意味着其他类型也有对应表示。

**把 system 更新移到更早保留的用户轮次。** 对应用户输入被省略时，将更新移到更早的 assistant 之前，会改变它在对话中的位置，并改写已发送的前缀。保留明确记录的[历史内更新限制](../../../../packages/llm/llm-deepseek/README.zh.md#known-limitations-and-deferred-work)，不编造用户消息或移动更新位置。

## 后果

保留文本的已保存通知可以通过 Messages 继续会话。提供方不再将这两种块类型诊断为用户输入生产方错误；结算通知生产方仍负责仅生成文本通知。这不保证提供方输入无损，也不保证兼容所有历史消息序列。

验证覆盖用户与工具结果过滤、持久化内容不变、HTTP 续接，以及 [headless Session 回放](../../../../snapshots/session/deepseek-messages-input-history/snapshot.yml)。序列化测试固定了历史内更新在对应用户输入被完全省略时的拒绝行为，覆盖下一个 assistant 之前和请求结束两种位置；文本或工具结果保留对应轮次时则可以通过。
