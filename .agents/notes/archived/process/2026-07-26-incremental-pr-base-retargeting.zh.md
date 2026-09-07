# Agent Note: 增量更新 PR 的 base 分支

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-incremental-pr-base-retargeting.md) | 中文

## 问题

将 PR（Pull Request）的 base 分支当前顶端提交合入 PR 分支的过程中，base 分支可能继续前移。若改从新的顶端提交重新开始，就会丢弃已经完成的冲突解决和验证工作。重写已经推送的合并还会抹去可供评审的历史记录。

## 决策

选择 merge-forward 时，每次观察到的 base 分支顶端提交都保留为独立的合并检查点。如果处理期间 base 分支继续前移，先完成并验证正在进行的合并，再将其提交；任务授权推送时，还要完成推送。完成这些步骤后，才能获取较新的 base，并通过单独的合并提交将其合入。在这条 merge-forward 序列中，不得放弃或重写任何检查点。

[原生堆叠与可选 rebase 决策](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)也允许独立或堆叠 PR 使用受 lease 保护的 rebase，评审后同样如此。本文只负责 merge-forward 路径。[堆叠 PR 落地 skill（技能）](../../../skills/dsh-merging-stacked-prs/SKILL.md)根据根 [AGENTS.md](../../../../AGENTS.md) 选择其中一种历史更新方式，[堆叠评审指南](../../../../docs/cookbook/responding-to-pr-review-on-a-stack.zh.md)则负责说明如何在依赖层之间传播修复。

## 曾考虑的替代方案

**中止当前工作，改从最新 base 重新开始。** 这会丢弃已经解决的冲突和完成的验证，重复劳动，并失去一个有用的恢复点。

**重写为一次同时包含两个 base 分支顶端的合并。** 这会掩盖冲突解决的顺序；如果第一次合并已经推送，还必须重写远程历史。

## 后果

- PR 的 base 多次前移时，这个 PR 可以包含多个用于合并 base 的提交。
- 已完成的工作不会被丢弃，而是保持可供评审和恢复。
- 合入较新的 base 会改变合并后的文件树，因此相关检查会在下一次推送前重新运行。
