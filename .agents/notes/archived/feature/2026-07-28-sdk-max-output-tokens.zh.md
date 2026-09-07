# Agent Note: SDK 最大输出 token 数

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-sdk-max-output-tokens.md) | 中文

## 问题

Python 与 TypeScript SDK 可以选择提供方和模型，却无法限制对话模型输出。即使评测宿主要求固定输出预算，运行时仍会省略 `GenerateOptions.maxTokens`，由提供方默认值控制。`compaction-basic.maxTokens` 只限制压缩摘要调用，不能承担这一职责。

## 决策

高层 SDK 公开一个可选的进程级输出上限：Python 命名为 `max_tokens`，TypeScript 命名为 `maxTokens`，共享的 `initialize` 协议载荷使用 `maxTokens`。JSON-RPC 服务端拒绝任何不属于正安全整数的值，并将通过校验的上限与提供方／模型路由一同保存。

每个由 SDK 创建的根 Agent 都通过 `AgentOptions.maxTokens` 获得该上限。agent loop（智能体循环）将它放入初始 `LlmCallConfig`；最终调用准备会保留显式值，或填入确切模型的适配器默认值，再将生效上限记录到请求 header，并从该持久化 header 重建每次分派的对话请求。因此，省略 SDK 选项时会应用所选适配器或提供方路由的默认值。

进程内 subagent 继承父级的提供方、模型和输出上限。显式的 `SubagentStartRequest.agentOptions.maxTokens`（包括通过 `dsh-tool-subagent` 配置的值）会覆盖该子级及其后代的继承值。`subagent-dsh-sdk` 为每次运行持有独立运行时：请求 `maxTokens` 会覆盖可选的实例默认值，解析后的上限再经过该子运行时自己的 SDK 握手。

压缩、会话标题生成、网页搜索和其他辅助调用继续使用各自持有的独立输出上限。`maxTokensAsSuccess` 仍然只负责结果映射，不会设置或改变上限。

## 考虑过的替代方案

**仅设置适配器环境变量。** 序列化器私有回退仅适用于 DeepSeek 适配器，不会出现在会话请求 header 中，对被拦截请求或其他适配器无效，也容易与提供方默认值混淆。适配器持有的默认值可以改为通过确切模型元数据公开，并在记录前填入提供方无关的请求配置。

**在每个 `session/prompt` 上增加 `maxTokens`。** 按轮次修改会扩充协议格式，并引入当前评测用例不需要的请求配置转换。运行时初始化选项可让一个 SDK 进程中的每个会话拥有相同、可重现的预算。

**复用 `compaction-basic.maxTokens`。** 压缩值控制摘要生成，而非普通对话请求。共用会耦合两类不同 token 预算，调整一方时会静默改变另一方。

## 后果

SDK 调用方无需修改 Cordis 组合即可限制模型输出，直接创建 Agent 也使用同一套经过校验的 `AgentOptions` 约定。该上限在持久化请求 header 中可见，并以 `GenerateOptions.maxTokens` 到达提供方适配器；DeepSeek 序列化会将其映射为 `max_tokens`。

一个 SDK 运行时只有一个默认上限。需要不同上限的调用方应运行独立的运行时实例，或使用声明 `agentOptions` 的 subagent 提供方；DSH SDK 会自然地为每次子级运行创建一个这样的运行时。达到上限时仍产生现有的 `max-tokens` 停止原因；将其映射为 `ok` 还是 `error` 仍由部署策略决定。
