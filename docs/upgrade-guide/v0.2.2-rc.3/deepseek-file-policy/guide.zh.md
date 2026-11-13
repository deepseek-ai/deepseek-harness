---
kind: upgrade-guide
description: "直接调用 DeepSeekFileStore 的代码需要传入解析后的文件上传策略。"
---

# 为 DeepSeekFileStore 解析文件上传策略

[English](guide.md) | 中文

## 变更

已发布的 `DeepSeekFilePolicy` 类型新增四个必填字段，分别为 `uploadConcurrency`、`uploadMaxRetries`、`uploadRetryDelayMs` 和 `uploadTimeoutMs`。自行构造策略并调用 `DeepSeekFileStore` 的 TypeScript 代码需要更新。

## 迁移

1. 从 `@deepseek-ai/dsh-llm-deepseek` 导入 `resolveAdapterOptions`。将原先手动构造的策略替换为 `resolveAdapterOptions(options).filePolicy`。如果用过自定义的文件有效期、提前刷新时间或清理数量，在 `options` 中分别传入 `fileExpiresAfterSeconds`、`fileRefreshMarginSeconds` 和 `fileQuotaCleanupBatch`。
2. 对调用代码运行类型检查，再用 `ensureUploaded` 上传一张图片。返回的记录中应包含该图片的 Files API ID。
