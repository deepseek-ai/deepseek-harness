---
kind: upgrade-guide
description: "pi-ai 路由返回的无效工具参数改为以 INVALID_TOOL_ARGUMENTS 而不是 MALFORMED_RESPONSE 失败，默认重试策略会重试它。"
---

# 无效工具参数错误码

[English](guide.md) | 中文

## 变更

pi-ai 路由返回的工具调用，如果其完成的参数不是合法 JSON 或不是 JSON 对象，DSH 会在 LLM 错误 finish 和失败轮次的 `turn/end` 错误中报告 `INVALID_TOOL_ARGUMENTS`。此前报告的是 `MALFORMED_RESPONSE`。

默认的 normal 重试策略现在在 `retryableCodes` 中包含 `INVALID_TOOL_ARGUMENTS`，因此请求会重新发送，而不是结束本轮。显式设置了 `retryableCodes` 的 `retryPolicy` 保留其列表。

## 迁移

1. 在对 LLM 错误 finish 或 `turn/end` 错误分类的代码中处理 `INVALID_TOOL_ARGUMENTS`；此前这类无效工具参数匹配的是 `MALFORMED_RESPONSE`。
2. 如果某个提供方的 `retryPolicy` 设置了 `retryableCodes`，并且需要重试无效工具参数，把 `INVALID_TOOL_ARGUMENTS` 加入该列表。若要在默认策略下保留旧行为，设置不含它的 `retryableCodes`。
3. 用 `ctx.llm.providerRetryPolicy(<provider>)` 检查结果，它会列出该路由重试的错误码。
