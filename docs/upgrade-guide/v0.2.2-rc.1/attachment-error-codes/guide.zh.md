---
kind: upgrade-guide
description: "AttachmentError 现在继承 HarnessError，工具失败与模型请求失败会记录附件错误码，不再丢失或报告为 UNKNOWN。"
---

# 附件失败保留其错误码

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-attachment` 的 `AttachmentError` 现在继承 `@deepseek-ai/dsh-error` 中的 `HarnessError`。其 `name`（`AttachmentError`）以及所有 `ATTACHMENT_*` 与图像准入错误码均保持不变。两类持久化结果会变化：

- 适配器无法读取图像附件而导致模型请求失败时，失败 turn 的 `turn/end` 错误过去记录 `code: 'UNKNOWN'`。现在记录 `AttachmentError` 的错误码，例如 `ATTACHMENT_NOT_FOUND`、`ATTACHMENT_CORRUPT`、`ATTACHMENT_READ_FAILED`，或 `INVALID_IMAGE`、`IMAGE_TOO_LARGE` 等图像准入错误码。
- 工具主体让 `AttachmentError` 逸出时，其 `tool/result` 现在记录 `error: { name: 'AttachmentError', code }`；过去结果中没有 `error`。`read_image` 同样记录 `AttachmentError` 的错误码，并在消息中写明文件与下一步。

`instanceof HarnessError` 现在会匹配 `AttachmentError`。`isAttachmentError` 不变。

## 迁移

1. 如果分析或重试规则把 `UNKNOWN` 模型失败当作兜底类别，请加入导出类型 `AttachmentErrorCode` 中的错误码；代码中用 `isAttachmentError` 识别这些失败。这些错误码没有统一前缀。
2. 如果代码先捕获 `HarnessError` 再捕获 `AttachmentError`，在两者需要不同处理的地方把 `AttachmentError` 检查移到前面。
3. 较早的 Session 日志仍保留 `UNKNOWN`；对比新旧日志的读取方应把附件读取的这两种记录视为同一类失败。
