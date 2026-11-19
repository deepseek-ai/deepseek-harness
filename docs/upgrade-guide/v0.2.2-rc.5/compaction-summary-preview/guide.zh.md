---
kind: upgrade-guide
description: 从会话事件读取压缩摘要。
---

# 压缩摘要预览

[English](guide.md) | 中文

## 变更

聊天中的压缩标记保留统计值和摘要事件序号。视图数据移除了包含 Markdown 正文的 `summary` 字段。

## 迁移

使用标记上非空的 `summaryEventSeq` 和会话地址读取对应的 `compaction/summary` 事件。在聊天中点击已完成的压缩行，即可在侧栏查看摘要。切换会话会保留预览。刷新浏览器会关闭摘要标签，可从同一行重新打开。
