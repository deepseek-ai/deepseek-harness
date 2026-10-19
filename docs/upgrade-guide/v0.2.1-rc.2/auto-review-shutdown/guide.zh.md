---
kind: upgrade-guide
description: "Auto review Session 在应用关闭时保留权限预设，重新打开时需要对应集成。"
---

# 关闭后重新打开 Auto review Session

[English](guide.md) | 中文

## 变更

此前，应用关闭可能会将存活的 Auto review Session 改为 Full access，结果取决于资源释放顺序。现在关闭会保留 Auto 及其审批策略。在运行中的应用内移除 Auto review 插件，仍会将其存活的 Auto Session 改为 Full access。

已保存的 Auto Session 必须在 Auto review 集成存在时才能重新打开。即使 headless 调用请求另一权限预设也一样：恢复会先验证已保存的选择，再应用新参数。既有策略记录不会被改写。

## 迁移

1. 在重新打开 Session 的 profile 中保持 Auto review 集成启用。如果通过一次性的 `--patch` overlay 加载集成，恢复时再次传入该 overlay。
2. 要将已保存的 Auto Session 改为另一预设，先在集成存在时重新打开它，再选择新预设。Headless 调用方可以在传入同一 Auto overlay 时提供 `--session-id <id> --permission-mode <preset>`。
3. 在集成存在时关闭并重新打开 Session。确认其所选预设仍为 Auto，除非你显式进行了更改。
