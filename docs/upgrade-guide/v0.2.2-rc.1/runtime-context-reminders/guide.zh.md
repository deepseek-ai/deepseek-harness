---
kind: upgrade-guide
description: "运行时上下文日志文本增加提醒包装，清空标记记录空的快照条目。"
---

# 运行时上下文提醒记录

[English](guide.md) | 中文

## 变更

新写入且 `source.kind: 'runtime-context'` 的 `user/message` 记录会将文本包在 `<system-reminder>` 内。首份快照介绍当前会话，不宣称覆盖更早的上下文；后续快照明确覆盖对话摘要保留的上下文。清空提醒现在携带 `form: 'snapshot'` 和 `sections: []`。

保留的旧快照或清空标记若没有 `source.sections`，会在下一次获准请求时刷新一次。这会增加一条消息，但不改写现有请求前缀。若旧快照的已记录条目未变，则不会仅因文案而刷新。Session 格式及公开的 `renderContextSnapshot()`、`joinContextSections()` 辅助方法保持不变。

## 迁移

1. 更新按字面匹配运行时上下文文本的消费方，使其识别提醒包装和首次／后续引导语。识别或检查记录时，优先使用 `source.kind` 及可用的 `source.sections`。
2. 将空条目视为上下文已清空，并继续支持不带结构化条目的旧记录。检查恢复会话输出中的首次快照和清空提醒；现有 Session 文件无需改写。
