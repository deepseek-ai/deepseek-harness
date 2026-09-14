# Agent Note: 以两个 LLM 适配器作为设计验证孪生体

Status: implemented

[English](2026-06-13-twin-llm-adapters.md) | 中文

## 问题

`dsh-llm` 拥有一套提供方无关的流式词汇：`StreamChunk` 协议（`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`）以及内容块类型（[内容块词汇](2026-06-11-content-block-vocabulary.zh.md)）。如果词汇仅针对单个适配器定义，就有可能将该适配器的特异行为固化到「中立」约定中：唯一实现碰巧做了什么，什么就成为事实上的规范；在第二个提供方到来之前，抽象层未经验证——而届时修复这种泄漏的代价已经很高。

## 决策

从一开始就针对同一份约定交付**两个**适配器，刻意基于不同的内部实现构建：

- `dsh-llm-deepseek`：直接 `fetch` + 仓库内翻译逻辑对接 DeepSeek API；SSE（Server-Sent Events）分帧委托给 `eventsource-parser`（[已归档的 SSE 解析器替换](../../archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.md)）。孪生身份在于自行持有 fetch/translate 内部实现而非委托给完整的提供方 SDK，不在于手写传输层管道。
- `dsh-llm-pi-ai`：通过 `@earendil-works/pi-ai` 库访问同一端点（该库有自己的事件词汇）。

二者共同执行的规则是：**凡 StreamChunk 词汇无法为两个实现同时表达的内容，都是核心词汇的缺陷**——立即暴露，而非等到下一个提供方接入时才发现。这对孪生适配器确立了现已记录在 `dsh-llm/src/types.ts` 中 `StreamChunk` 上的约定：usage 在 finish 之前发出、finish 之后不再有任何事件、工具调用的 `arguments` 全程以原始 JSON 字符串传递，以及消费方必须在两侧都处理的两条合法错误路径（`stream()` 抛异常，*或者*以 `finish {kind:'error'|'aborted'}` 结束）。这一分歧正是由基于库的适配器暴露出来的，单一直接 fetch 适配器会将其隐藏。

## 曾考虑的替代方案

- **单一适配器**：代码更少、e2e 成本减半，但「提供方无关」的声明无从验证；词汇会默默编码 DeepSeek-via-fetch 的假设。
- **mock 第二适配器**：更便宜，但不会触及真实提供方的协议格式（wire format）怪癖，因此证明力有限。孪生体是真实对真实的验证。

## 后果

孪生体使适配器和需要密钥的 e2e 维护量翻倍——两者都覆盖 V4 Flash 和 Pro 在各代表性推理（reasoning）模式下的行为——换来的是持续的 seam 中立性验证和第二份实现示例。两个适配器均使用 `apiKey`、`baseURL` 和 `models`；直接 fetch 适配器暴露 `thinking`/`reasoningEffort`，pi-ai 适配器暴露一个 `reasoning` 级别。未来如果有一致性测试套件，可以通过后续 Agent Note 论证退役其中一个适配器。

[Messages 适配器](../feature/2026-09-07-deepseek-messages-adapter.zh.md) 在 `llm-deepseek` 内增加 Anthropic 协议实现，并遵守相同的流约定。
