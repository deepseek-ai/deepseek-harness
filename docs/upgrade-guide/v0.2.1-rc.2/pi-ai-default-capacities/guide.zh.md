---
kind: upgrade-guide
description: "配置和目录均未描述容量的 pi-ai 模型会继承更大的上下文与输出容量，除非提供方显式配置默认值。"
---

# pi-ai 默认模型容量

[English](guide.md) | 中文

## 变更

对于配置和已安装目录均未提供容量的模型，`llm-pi-ai` 将 `defaultContextWindow` 从 262,144 提高到 1,000,000 tokens，将 `defaultMaxTokens` 从 32,768 提高到 128,000 tokens。更大的假定上下文窗口可能推迟自动压缩。显式模型容量、目录值和提供方默认值仍保留原有优先级。输出容量回退值不会成为 Harness 请求级 `maxTokens` 默认值。

## 迁移

1. 核对自定义端点的实际限制。如果限制不同，在 `cordis.patch.yml` 的 `llm-pi-ai` 配置中设置 `providers.<provider>.defaultContextWindow` 和 `providers.<provider>.defaultMaxTokens`。如需保留原默认值，分别填写 `262144` 和 `32768`。
2. 同一提供方的模型限制不同时，在相应 `providers.<provider>.models` 条目上设置 `contextWindow` 和 `maxTokens`。显式配置的模型 `maxTokens` 同时提供 Harness 请求默认值。
3. 重新打开 profile 配置，确认保存的数值。参见[提供方配置参考](../../../../packages/llm/llm-pi-ai/README.zh.md)。
