# Agent Note: 通过 Messages 回放非法历史工具输入

Status: implemented

[English](2026-09-16-messages-historical-tool-input.md) | 中文

## 问题

Chat Completions 将工具参数保留为字符串，其中可能包含失败调用产生的非法 JSON。将这段历史切换到 Messages 时，每个 `tool_use.input` 都必须是对象。拒绝一条历史参数就会阻断包含它的所有后续请求，即使工具重试已经成功；包含同一调用的摘要请求也会失败。

## 决策

[Messages 序列化器](../../../../packages/llm/llm-deepseek/src/serialize.ts) 遵循 [pi-ai 历史转换](../../../../packages/llm/llm-pi-ai/src/replay.ts)的做法：只在发出的历史工具输入中，将非法 JSON 和非对象值替换为 `{}`。调用 ID、名称、结果和原始 Session 记录保持不变。原生回放元数据有效、缺失或不可用时均采用此规则，也不会重新执行历史调用。

这取代了 [Messages 适配器决策](../feature/2026-09-07-deepseek-messages-adapter.zh.md)中的历史参数拒绝规则。新生成的 Messages 响应在成功完成前仍要求工具参数是有效对象；达到输出上限时仍按现有规则裁剪。不改变 Session 事件、持久化类型或协议配置。

## 考虑过的替代方案

**拒绝非法历史。** 失败调用可以继续作为相关证据保留，而不必阻断所有后续模型请求。

**修复或覆盖已存参数。** 猜测缺失的引号或保留部分解析结果可能改变请求的操作。只在请求中使用空输入可以保留原始证据，也不需要迁移。

**删除调用。** 对应结果仍引用调用 ID；同时保留调用和结果，可以保留工具交互而不编造参数。

## 后果

Messages 可以在省略不可用历史参数的同时继续会话，并保留调用身份和结果。模型看到的是 `{}`，而不是原始非法文本；该兜底与 pi-ai 一样不产生诊断。原始参数仍可在 Session 日志中查阅；这不保证提供方输入无损，也不修复新生成的非法调用。

验证覆盖仅接受对象的转换、失败结果后的用户输入、JSON 往返、有效与降级的回放元数据、通过已发布 headless profile 和真实 Messages 序列化器运行的[录制 Session](../../../../snapshots/session/deepseek-messages-invalid-tool-history/snapshot.yml)，以及需要凭据的真实 Messages 续接。
