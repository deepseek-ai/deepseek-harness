# Agent Note: 适配器持有的最大 token 默认值

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-adapter-owned-max-token-defaults.md) | 中文

## Problem

LLM（大语言模型）适配器可以序列化显式的 `GenerateOptions.maxTokens`，但无法通过 Cordis 配置建立可重建的对话默认值。仅在提供方序列化中应用回退，会导致协议请求与持久 `request/header` 不一致；若将各提供方默认值都放进 agent loop（智能体循环），则会把部署与模型策略转移到提供方无关的驱动器中。

## Decision

`LlmResolvedModelInfo.defaultMaxTokens` 携带一条确切提供方／模型路由的可选单次请求输出上限，该值由适配器配置。`LlmRuntime` 将其校验为正的安全整数，并且仅在调用方省略值时才填入 `LlmCallConfig.maxTokens`。准备后的调用会将已填入的 `maxTokens` 和 `reasoningEffort` 字段标记为适配器默认值；显式请求值或 agent 选项不带该标记，因此优先且不会被自动调整。

agent loop 仍在记录 `request/header` 前准备调用，因此生效配置和标明哪些字段由适配器默认值填入的标记，会在分派前成为持久请求事实。下一次 `agent/request` waterfall（瀑布式事件）前，agent loop 会从提议中移除带标记字段，随后精确模型解析会再次填入当前路由的默认值。因此，切换提供方／模型不会把前一个适配器的默认值误当成显式覆盖，而显式对话值则会保留。直接调用 `LlmRuntime.stream()` 时，也会在最终适配器边界解析同一默认值。该字段是请求默认值，而非模型输出硬上限；沿用提供方自有默认值的适配器会省略它。

原生 DeepSeek 适配器在 Cordis 配置中公开 `maxTokens`，默认值为 256,000 token，并将生效值映射为 `max_tokens`。其默认上下文容量为 1,000,000 token：两个内置 V4 配置项均公布这一精确容量；不含容量的已配置项和未列出的原样传递 id 则继承同一个适配器级回退值。

## Alternatives considered

**仅在 DeepSeek 序列化中应用默认值。** 不予采纳，因为提供方协议会包含持久请求 header 中缺失的模型可见值。

**在每个已发布应用中设置 `AgentOptions.maxTokens`。** 不予采纳，因为应用会重复适配器部署策略，直接 LLM 调用的行为将不同，而且选择另一个提供方后仍会保留 DeepSeek 专用上限。

**将 256,000 表示为每模型硬上限。** 不予采纳，因为配置值是所需请求预算，无法证明每个已配置端点都会拒绝更大的输出。显式调用方仍具有最终决定权。

**由提供方默认值控制。** 对原生 DeepSeek 部署不予采纳，因为产品要求各兼容端点都采用稳定的 256,000 token 对话预算。

## Consequences

DeepSeek 对话默认发送 `max_tokens: 256000`，会话请求 header 会记录该值，并记录该值由适配器提供。部署可以通过 `llm-deepseek.config.maxTokens` 更改适配器默认值；每个 agent 和每次请求的值都会覆盖它。更改路由会重新填入新路由精确匹配到的适配器默认值，而不是继续沿用 DeepSeek 派生出的值。其他适配器会保留现有行为，直至主动公布 `defaultMaxTokens`。

对于预分配请求输出的端点，256,000 token 的输出预算会占用 1,000,000 token 上下文中的很大部分。如果部署使用的 gateway 或模型仅支持较小预算，则必须调低 `maxTokens`；显式配置优于无文档说明的提供方回退值。
