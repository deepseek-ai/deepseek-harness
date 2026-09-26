# Agent Note: 由 dsh-llm 拥有的提供方无关内容块词汇

Status: implemented

[English](2026-06-11-content-block-vocabulary.md) | 中文

## 问题

harness 需要一套统一的内部消息语言，供 agent loop（智能体循环）、会话日志和所有插件共同使用。

## 决策

自主拥有词汇：user、assistant 与 system 消息是类型化内容块的数组（`text`、`reasoning`、`tool-call`），其联合类型派生自可合并扩展的 `ContentBlockMap`，插件通过声明合并添加新的块类型。Tool result 是一等 tool-role message，结果块属于该 message 自己的 content；已发布的 Session format v3 仍将历史 `tool-result` content block 保存在 user-role 包装中，邻接的 V3 到 V4 边会将该包装提升为一等角色。同一可合并扩展映射模式为所有「字符串化」字段提供类型（`MessageSource`、`FinishReason`、`TurnTrigger`、`TurnEndReason`）。流式输出采用原始分片协议；`BlockAssembler` 是唯一的共享组装实现。适配器负责转换为提供方的协议格式（wire format）——映射成本留在适配器中，正是它该在的地方。

会话内上下文注入（`context/message`）和轮次中途 steering（中途引导）最初渲染为带标签的 user-role 信封（system-reminder 模式），而非引入新角色，因此适配器无需承担额外负担。如今两者都投影为无包装的普通用户内容；见[注入内容信封 Agent Note](../simplification/2026-07-20-unwrap-injected-content-envelopes.zh.md)。实际适配器验证已确认此渲染方式符合当前 DeepSeek 的行为；如果未来某提供方出现不兼容，应在该适配器内处理，而非引入新的规范角色。

## 曾考虑的替代方案

- **镜像 DeepSeek/OpenAI chat-completions 结构**：对第一个提供方零映射成本，但对富内容（推理、结构化块形式的工具结果）处理不便。
- **原样采用 Anthropic Messages 块结构**：经过实战检验，但规范类型将镜像一个 harness 并非首要对接的第三方 API。

## 后果

- 推理（reasoning）在核心层有了归属，无需依赖提供方特有的结构。
- 多模态块只有在适配器、UI 和上下文压缩（context compaction）三方协同支持后才会回归；见 [drop-image Agent Note](../../archived/simplification/2026-07-04-drop-image-content-block.md)。
- 缓存提示与 assistant prefill 在有实际适配器能兑现之前保持缺席；见[无生产者的词汇变体](../../archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)与[无端到端可用路径的请求旋钮](../../archived/simplification/2026-07-04-drop-inert-request-knobs.md) Agent Note。
- 每个适配器都需承担翻译成本；首批真实适配器已验证了流式输出协议，新适配器应继续在适配器本地测试中验证其提供方特有的映射。
- 跨包边界的 ID 使用品牌类型（`ToolCallId`、agent 与会话共享的 `SessionId`）——零运行时开销的名义类型。
