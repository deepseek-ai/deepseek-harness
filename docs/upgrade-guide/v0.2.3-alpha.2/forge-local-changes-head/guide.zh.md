---
kind: upgrade-guide
description: "forgePanel.diffBases 与 forgePanel.localCommits 在 Session 之后新增 head 参数。"
---

# Forge 面板的本地变更读取要指明查看的分支

[English](guide.md) | 中文

## 变更

`forgePanel.diffBases` 这个 Remote 原先的参数是 `(session, query)`，`forgePanel.localCommits` 是 `(session, base)`。现在两者都在 Session 之后多了一个 `head`：`diffBases(session, head, query)` 与 `localCommits(session, head, base)`。`head` 的类型是 `string | null`：它是 `refs/heads/` 或 `refs/remotes/` 下某个分支的完整引用名，读取时用这个分支代替 Session 检出的分支；null 表示 Session 自己的检出，也就是两个方法原先读取的内容。

`ForgeLocalScope` 是 `forgePanel.localDiff`、`forgePanel.localText` 的参数，也是 `forgePanel.changesLens` 的本地来源；它的四种 kind 都新增了含义相同的可选 `head`。`ForgeBaseBranch` 与 `ForgeLocalDiff` 新增可选的 `worktree`。新增两个错误码：分支不存在时为 `forgePanel/head-missing`；`branch` 以外的范围指定了没有 worktree 检出的 `head` 时为 `forgePanel/no-working-tree`。

受影响的是 `@deepseek-ai/dsh-experimental-client-ui-forge` 之外调用 `forgePanel.diffBases` 或 `forgePanel.localCommits` 的代码。只构造 `ForgeLocalScope` 或只读取 `ForgeBaseBranch`、`ForgeLocalDiff` 的代码不受影响，因为新增的成员都是可选的。

## 迁移

1. 在每个 `forgePanel.diffBases` 调用中，把 `null` 作为第二个参数，放在查询文字之前：`diffBases(session, null, query, signal)`。
2. 在每个 `forgePanel.localCommits` 调用中，把 `null` 作为第二个参数，放在基准之前：`localCommits(session, null, base, signal)`。
3. 运行类型检查；两处调用都带上新参数后即通过。读取结果与原先相同。
