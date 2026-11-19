---
kind: upgrade-guide
description: "归档清理会删除创建者沙箱策略为只读的检出目录，且其 Git 命令不经沙箱执行。"
---

# 归档清理不再参考创建者的沙箱策略

[English](guide.md) | 中文

## 变更

[v0.2.2-rc.1](../../v0.2.2-rc.1/archive-worktrees/guide.zh.md) 中，创建者的沙箱策略为只读时会保留被归档 Session 的检出目录，删除用的 Git 命令也受该策略约束。现在归档即视为用户授权删除该目录：清理不读取任何沙箱策略，无论创建者是什么模式都会删除，`git status` 与 `git worktree remove` 以 Host 用户的权限在沙箱外执行。Git 照常读取仓库配置；hooks 与文件系统监视器仍然关闭。

约束删除的检查不变：目录位于源检出目录配置的池中，登记在记录的分支上，没有锁也不是 detached HEAD，没有已跟踪改动、未跟踪文件或已初始化的子模块；没有未归档 Session 引用它；分支及其提交保留。

依赖只读创建者在归档后保留检出目录、或依赖沙箱约束清理的用户会受影响。

## 迁移

1. 要在归档时保留所有检出目录，在 `cordis.yml` 中为 worktree 服务设置 `retainOnArchive: true`，或在插件页 Forge 面板的开关中打开。
2. 要保留某一个检出目录，在归档创建者之前让其中留有已跟踪改动或未跟踪文件，或让一个未归档 Session 在其中工作。
3. 归档一个创建过干净 worktree 的测试 Session，再查看 `ctx.worktrees.cleanupOf(sessionId, null)`：`removed` 表示新行为生效，`null` 表示 `retainOnArchive` 生效。
