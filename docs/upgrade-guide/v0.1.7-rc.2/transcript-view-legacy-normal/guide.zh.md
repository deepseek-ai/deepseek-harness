---
kind: upgrade-guide
description: "旧值 ui-chat.transcriptView: normal，以及非 Desktop Web 中未设置的值，改为按“详细”而非“标准”展示。"
---

# 旧值 `normal` 的工作步骤展示改为“详细”

[English](guide.md) | 中文

## 变更

Host 设置 `ui-chat.transcriptView` 对应设置 → 通用设置 → 工作步骤展示。在 v0.1.7-rc.2 中，客户端把旧保存值 `normal` 按 `standard` 展示；设置缺失、为 `null` 或无效时，所有客户端都使用 `standard`。

从下一版本起：

- 保存的 `normal` 在 Desktop 和 Web 中均按 `detailed` 展示，磁盘中的保存值不会被改写。
- 设置缺失、为 `null` 或无效时，非 Desktop Web（npm 安装的 `dsh web`）按 `detailed` 展示；Desktop 仍使用 `standard`。
- 已保存的 `compact`、`standard`、`detailed` 和 `verbose` 保持不变。

依赖旧读取方式的用户会看到运行中轮次的过程组正文直接展开，而不是收起的摘要。

## 迁移

1. 如需保留原有展示，打开设置 → 通用设置 → 工作步骤展示并选择“标准”。客户端会把 `standard` 保存到 `ui-chat.transcriptView`，此后的默认值变化不影响该值。
2. 确认：发起一个调用工具的轮次，检查其过程组显示收起的摘要和实时任务详情。
