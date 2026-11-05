---
kind: upgrade-guide
description: "AttachmentError 现在继承 HarnessError，工具失败与模型请求失败会记录附件错误码，不再丢失或报告为 UNKNOWN。"
---

# 附件失败保留其错误码

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-attachment` 的 `AttachmentError` 现在继承 `@deepseek-ai/dsh-error` 中的 `HarnessError`。其 `name`（`AttachmentError`）以及所有 `ATTACHMENT_*` 与图像准入错误码均保持不变。两类持久化结果会变化：

- 适配器无法读取图像附件而导致模型请求失败时，失败 turn 的 `turn/end` 错误过去记录 `code: 'UNKNOWN'`。现在记录附件错误码，例如 `ATTACHMENT_NOT_FOUND`、`ATTACHMENT_CORRUPT` 或 `ATTACHMENT_READ_FAILED`。
- 工具主体让 `AttachmentError` 逸出时，其 `tool/result` 现在记录 `error: { name: 'AttachmentError', code }`；过去结果中没有 `error`。`read_image` 则把附件失败转换为 `ImageInputError` 错误码。

`instanceof HarnessError` 现在会匹配 `AttachmentError`。`isAttachmentError` 不变。

## 迁移

1. 如果分析或重试规则把 `UNKNOWN` 模型失败当作兜底类别，请加入这些附件错误码，或按 `ATTACHMENT_` 前缀路由。
2. 如果代码先捕获 `HarnessError` 再捕获 `AttachmentError`，在两者需要不同处理的地方把 `AttachmentError` 检查移到前面。
3. 较早的 Session 日志仍保留 `UNKNOWN`；对比新旧日志的读取方应把附件读取的这两种记录视为同一类失败。
