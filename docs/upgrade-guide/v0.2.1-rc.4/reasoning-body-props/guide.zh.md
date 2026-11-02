---
kind: upgrade-guide
description: "推理 Body Slot 的 text 提供显示文本，rawText 保留原始输出。"
---

# 推理 Body Slot 的文本字段

[English](guide.md) | 中文

## 变更

`conversation.chat.reasoning.body` 扩展通过新增的 `rawText` 字段接收模型输出。现有的 `text` 字段提供 Chat 处理后的显示文本，替代原始输出。`running` 保持不变。这会影响自定义推理渲染器和翻译包装组件。

`conversation.chat.reasoning.content` Factory 仍接收 `text`、`running` 和可选的 `labels`。它渲染调用方选定的 Markdown。[Chat README](../../../../packages/client/ui-chat/README.zh.md#grouped-rendering) 介绍了该 Slot。

## 迁移

1. 在普通渲染、翻译请求和未翻译视图中继续读取 `text`。需要完整模型输出的扩展改为读取 `rawText`。
2. 向 Content Factory 传入选定的 `text` 或其译文，不要重复执行 Chat 的显示处理。
3. 重新构建扩展，使用每种支持的模型格式验证流式与完成后的渲染、翻译和未翻译视图。
