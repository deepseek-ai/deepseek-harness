---
kind: upgrade-guide
description: "ForgeProvider.diff 与 ctx.forge.diff 需要传入要读取的 head 提交，ForgeFailure 新增 stale 代码，ChangeRequestSnapshot 新增 threadsTruncated。"
---

# Forge diff 读取指定的 head 提交

[English](guide.md) | 中文

## 变更

`ForgeProvider.diff(ref, signal)` 改为 `diff(ref, headSha, signal)`，`ctx.forge.diff(ref, signal)` 改为 `ctx.forge.diff(ref, headSha, signal)`。提供方只在补丁描述 `headSha` 时返回补丁；变更请求的 head 已是其他提交时，resolve 为代码为新增 `stale` 的 `ForgeFailure`。此时若该变更请求正被 watch，`ctx.forge.diff` 会立即重新轮询它。GitHub 提供方在一次 GraphQL 查询中读取 head 与基准提交，head 是其他提交时返回 `stale`，否则不再使用 `gh pr diff`，改经 compare API 读取这两个提交之间的补丁。超过 300 个文件、此前被 `gh pr diff` 判为过大的 GitHub pull request 现在显示完整 diff；只有输出超过 `maxOutputBytes` 或 GitHub 自身拒绝时才仍为 `too-large`。

`ForgeFailure['code']` 新增 `stale`。`ChangeRequestSnapshot` 新增必填字段 `threadsTruncated: boolean`；提供方只统计了部分评审讨论时，它表示 `unresolvedThreads` 只是下限。

`forgePanel.changeRequestDiff` Remote 以 `forgePanel/stale-head` 拒绝，不再返回在其他 head 读到的补丁。

受影响的是用 `ctx.forge.register` 注册的第三方 `ForgeProvider` 实现、调用 `ctx.forge.diff` 或 `forgePanel.changeRequestDiff` 的代码、构造 `ChangeRequestSnapshot` 的代码，以及对 `ForgeFailure['code']` 做穷尽分支的代码。这些类型都来自 `@deepseek-ai/dsh-experimental-forge`。

## 迁移

1. 在 `ForgeProvider` 的 `diff` 中，于 `signal` 之前加入 `headSha: string` 参数。只有托管平台在 `headSha` 处计算出补丁时才返回补丁，否则返回 `{ code: 'stale', message }`。[`GitHubProvider.diff`](../../../../packages/experimental/forge-github/src/provider.ts) 先读取当前 head，再读取按提交寻址的 diff。
2. 每次调用 `ctx.forge.diff` 都传入 head 提交，通常是 `ctx.forge.latest(ref)` 的 `snapshot.headSha`。收到 `stale` 时，等待更新的状态并按其 head 重新读取；不要把结果缓存在旧 head 下。
3. 提供方构造的每个 `ChangeRequestSnapshot` 都要设置 `threadsTruncated`：`unresolvedThreads` 统计了全部评审讨论时为 `false`。
4. 凡对 `ForgeFailure['code']` 做穷尽分支的地方都处理 `stale`；凡区分 `forgePanel.changeRequestDiff` Remote 错误代码的调用方都处理 `forgePanel/stale-head`。
5. 运行类型检查；所有 `diff` 实现与调用都传入 head 提交、所有快照都设置 `threadsTruncated`、没有未处理的 `ForgeFailure` 代码时，检查通过。
