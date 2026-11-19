# Agent Note: 以启用 rerere 的 rebase 刷新 PR 分支

Status: implemented

[English](2026-11-19-prefer-rebase-with-rerere.md) | 中文

## 问题

[原生堆叠决策](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)对独立 PR 分支和堆叠 PR 分支同等允许 merge-forward 与 rebase。因此 agent 每次刷新都要选择一种历史，长期存在的分支会积累评审者必须跳过的合并提交。中止后重试 rebase、在父层被改写后 rebase 堆叠子层，或一次 rebase 中多个提交改动同一 hunk 时，rebase 还会要求重新解决已经解决过的冲突。

## 决策

agent 以 rebase 刷新独立 PR 分支和堆叠 PR 分支，包括评审后。rebase 前，agent 在每个克隆中用 `git config rerere.enabled true` 启用一次 Git 的已记录冲突解决复用（rerere），Git 会记录每个已解决的冲突，并在之后的 rebase 中再次出现相同冲突时应用记录的解决结果。agent 不设置 `rerere.autoUpdate`，因此 Git 把复用的解决结果留在未暂存状态以供检查；agent 检查并暂存后再继续 rebase。

只有 PR 作者明确要求时才使用 merge-forward。增量 merge-forward 流程，以及在合入更新的 base 之前保留进行中检查点的规则，仍可用于这种情况。

lease 保护不变：独立分支的改写以 `--force-with-lease=<branch>:<observed-oid>` 发布，`gh stack push` 与 `gh stack sync` 为其管理的分支提供 lease 保护，禁止直接使用 `--force`。原生堆叠决策继续负责堆叠关联、落地，以及改写后的评审审计。

## 曾考虑的替代方案

**继续同等允许 merge-forward 与 rebase。** 这会把历史选择留给每次刷新，并保留 rebase 优先所消除的合并提交。

**无例外地要求 rebase。** PR 作者可能有理由保留合并检查点，例如把一次已完成的大规模冲突解决保留为恢复点；作者要求这一例外保留了该选项。

**不启用 rerere 的 rebase。** 重试的 rebase 和堆叠级联 rebase 会要求重新解决已经解决过的冲突，既耗时，也可能产生不一致的解决结果。

## 后果

- PR 分支保持线性历史，评审者看到的是位于当前 base 之上的分支自身提交。
- 每次刷新都会改写 commit OID，因此每次刷新后都要审计 head、评审线程、批准状态、可合并性和检查结果。
- 记录的解决结果可能应用到正确解决方式已经变化的冲突上；agent 仍要在暂存前检查每个复用的解决结果。
- 记录的解决结果存放在仓库公共 Git 目录下的 `rr-cache` 中，因此同一克隆的关联 worktree 共享这些记录，其他克隆则不共享。
