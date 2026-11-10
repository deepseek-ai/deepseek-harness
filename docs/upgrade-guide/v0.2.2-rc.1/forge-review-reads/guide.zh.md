---
kind: upgrade-guide
description: "ForgeFailure 新增 unsupported 代码；提供方不支持读取评审讨论时，ctx.forge.readReview 返回它。"
---

# Forge 失败代码报告不支持的读取

[English](guide.md) | 中文

## 变更

`ForgeFailure['code']` 新增 `unsupported`。新增的 `ctx.forge.readReview(ref, headSha, signal)` 对应可选的 `ForgeProvider.readReview`；变更请求的提供方不支持读取评审讨论时，它返回 `unsupported`。其他读取的代码不变：提供方未实现 `fetchChecks` 时，`ctx.forge.fetchChecks` 仍返回 `unavailable`。

受影响的是对 `ForgeFailure['code']` 做穷举的代码，例如 `Record<ForgeFailure['code'], …>` 查表，或以 `assertNever` 结尾的 `switch`。所有类型都来自 `@deepseek-ai/dsh-experimental-forge`。提供方无需修改：`readReview` 是可选方法。

## 迁移

1. 在所有对 `ForgeFailure['code']` 做穷举的地方处理 `unsupported`，把它当作提供方缺少的能力，而不是需要重试的读取失败。
2. 运行类型检查；没有未处理的 `ForgeFailure` 代码时即通过。
