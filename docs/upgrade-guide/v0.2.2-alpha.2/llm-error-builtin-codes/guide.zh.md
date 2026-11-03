---
kind: upgrade-guide
description: "`new LlmError` 只接受内置失败 code；其他 code 改用 `LlmError.fromFailure`。"
---

# `new LlmError` 只接受内置失败 code

[English](guide.md) | 中文

## 变更

在 `@deepseek-ai/dsh-llm` 中，`LlmError` 构造函数的 `code` 参数原为 `string`，现为 `BuiltinLlmFailureCode`：`LLM_FAILURE_CODES` 的键或 `HTTP_<status>`。运行时行为和 `LlmFailure.code` 不变。用其他 code 构造 `LlmError` 的 TypeScript 代码（例如仓库外的提供方适配器或测试替身）将无法通过编译。

## 迁移

1. 把每个 `code` 不是内置值的 `new LlmError(message, code, options)` 改为 `LlmError.fromFailure({ message, code, ...facts }, { cause })`，其中 `facts` 包含需要的 `status`、`providerRetryAfterMs`、`requestId` 或 `offloadImages`。
2. 重新抛出从流中收到的失败时，使用 `LlmError.fromFailure(finish.failure)`，而不是把 `finish.failure.code` 传给构造函数。
3. 用 `tsc` 确认没有任何 `LlmError` 构造报告 code 不能赋值给 `BuiltinLlmFailureCode`。
