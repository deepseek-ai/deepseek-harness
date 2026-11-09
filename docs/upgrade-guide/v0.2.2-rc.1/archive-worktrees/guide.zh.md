---
kind: upgrade-guide
description: "归档 Session 可以删除其干净的工作树并保留分支，Forge bundle 只挂载一个工作树服务。"
---

# 归档时清理工作树

[English](guide.md) | 中文

## 变更

归档 Session 以前会保留检出目录。工作树服务现在把它创建的每个检出目录记录为 `plugin:worktree/created` Session 事件；当创建它的 Session 被归档时，若没有未归档的 Session 引用该目录、创建者的策略不是只读，且 Git 未发现跟踪文件改动、未跟踪文件、已初始化的子模块、锁或分离 HEAD，就用不带 force 的 `git worktree remove` 删除它。`node_modules` 之类被忽略的文件，以及 `git status` 不报告的 skip-worktree 或 assume-unchanged 文件改动，都不会保留目录，Git 会丢弃它们。含已提交内嵌仓库的检出目录会被 Git 拒绝删除，因此保留，归档提示显示清理失败。分支和提交仍会保留。服务的 `retainOnArchive` 设置默认关闭，开启后改为保留所有检出目录。本版本之前创建的检出目录没有该事件，不会被扫描；更早归档的 Session 也不会。参见[工作树服务](../../../../packages/experimental/worktree/README.zh.md)。

Forge bundle 为面板和 `create_worktree` 工具挂载同一个 `worktree` 服务。隔离第二个服务的 `forge-worktree` 行与 `optional-forge-panel` 组已移除；面板是顶层的 `forge-panel` 行。

## 迁移

1. 如果检出目录必须供 DSH 之外继续使用，请保持其 Session 未归档，在归档前用 `git worktree lock <path>` 锁定它，或在插件页 Forge 套件的 worktree 行上开启**归档时不删除工作树**（`retainOnArchive`），它会保留所有检出目录。被忽略的文件不会保留，skip-worktree 或 assume-unchanged 文件的改动也不会：归档前请提交这些改动，或用 `git update-index --no-skip-worktree` 或 `--no-assume-unchanged` 清除标记。
2. 要继续使用已归档且检出目录已删除的 Session，请取消归档并使用**恢复工作树**。保留的分支会在记录的路径重新检出。
3. 在 profile 的 `cordis.patch.yml` 中，把针对 `forge-worktree` 的覆盖迁到 `worktree` 行，把针对 `optional-forge-panel` 的覆盖迁到 `forge-panel` 行；对 `forge-panel` 设置 `disabled: true` 可以只关闭面板。
4. 用 `git branch --list` 确认分支与提交仍然存在，并确认**恢复工作树**使记录的检出目录重新可用。Session 日志无需迁移。
