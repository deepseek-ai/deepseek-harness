---
kind: upgrade-guide
description: "DeepSeek 流式内容拒答的错误码从 MALFORMED_RESPONSE 改为 CONTENT_REFUSED。"
---

# DeepSeek 内容拒答错误码

[English](guide.md) | 中文

## 变更

当 DeepSeek 以 `stop_reason: "refusal"` 结束模型流时，DSH 在 LLM 的错误终止块和失败轮次的 `turn/end` 错误中报告 `CONTENT_REFUSED`。此前，适配器对这一停止原因报告 `MALFORMED_RESPONSE`。

## 迁移

1. 在对 LLM 错误终止块或 `turn/end` 错误分类的代码中处理 `CONTENT_REFUSED`，向用户说明提供方已拒绝该请求。
2. 回放一条以 `refusal` 结束的 Messages 流，确认处理程序进入拒答分支。
