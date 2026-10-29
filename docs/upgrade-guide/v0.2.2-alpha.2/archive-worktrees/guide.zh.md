---
kind: upgrade-guide
description: "归档 Session 可以删除其干净的 UI 工作树，同时保留分支。"
---

# 归档时清理工作树

[English](guide.md) | 中文

## 变更

归档 Session 以前会保留检出目录。启用 Forge bundle 后，归档现在可以删除通过新会话 UI 创建且干净、无人使用的工作树。分支和提交仍会保留。有修改、忽略文件、被共享、仍有活动或无法确认安全的检出目录会保留，不额外提示；不扫描此前已归档的 Session。参见 [Forge 面板行为](../../../../packages/experimental/client-ui-forge/README.zh.md)。

## 迁移

1. 如果检出目录必须供 DSH 之外继续使用，请保持其 Session 未归档，或在归档前用 `git worktree lock <path>` 锁定它。
2. 要继续使用已归档且检出目录已删除的 Session，请取消归档并使用**恢复工作树**。保留的分支会在记录的路径重新检出。
3. 用 `git branch --list` 确认分支与提交仍然存在，并确认**恢复工作树**使记录的检出目录重新可用。Session 日志无需迁移。
