---
kind: upgrade-guide
description: "ChangeRequestSnapshot 新增必填的概览字段，ChangeRequestCheck 新增必填的 rerun 字段，ForgeActionFailure 新增 unknown 代码。"
---

# Forge 快照携带变更请求概览，操作报告结果不明

[English](guide.md) | 中文

## 变更

`ChangeRequestSnapshot` 新增七个必填字段：`reviewers` 与 `reviewersTruncated`、`closingIssues` 与 `closingIssuesTruncated`、`branchUpdates`、`canRequestReviews`，以及 `canRerunChecks`。`ChangeRequestCheck` 新增必填的 `rerun: ForgeCheckId | null`，指出提供方如何重跑该检查。变更请求卡片读取这些字段，列出评审者、关联 issue 与分支更新，并提供重跑失败检查、请求评审与更新分支。

`ForgeActionFailure['code']` 新增 `unknown`：主机的答复无法确认结果，改动可能已经生效。GitHub 提供方在 GitHub 未确认已审阅标记、评审请求与分支更新的结果时返回它；`ctx.forge.markReady` 与 `ctx.forge.merge` 只在提供方返回它时才会返回。

`ForgeProvider` 还新增可选的 `viewedFiles` 与 `setViewed`、`rerunChecks`、`requestReviews` 与 `reviewerCandidates`，以及 `updateBranch`；未实现它们的提供方照常工作，卡片不提供对应操作。

受影响的是通过 `ctx.forge.register` 注册的第三方 `ForgeProvider` 实现，以及其他构造 `ChangeRequestSnapshot` 或 `ChangeRequestCheck` 值的代码。所有类型都来自 `@deepseek-ai/dsh-experimental-forge`。

## 迁移

1. 在提供方构造的每个 `ChangeRequestCheck` 中设置 `rerun: null`，除非提供方实现了 `rerunChecks`；实现了的提供方为每个可重跑的检查给出能再次解析的品牌化 `ForgeCheckId`，GitHub Actions 运行的做法见 [`actionsRun`](../../../../packages/experimental/forge-github/src/graphql.ts)。
2. 在每个 `ChangeRequestSnapshot` 中设置托管平台报告的概览字段。没有平台数据时，使用 `reviewers: []`、`reviewersTruncated: false`、`closingIssues: []`、`closingIssuesTruncated: false`、`branchUpdates: []`、`canRequestReviews: false` 与 `canRerunChecks: false`；卡片随后只显示评审结论，不提供概览操作。
3. 可选地实现新的提供方方法；[`GitHubProvider`](../../../../packages/experimental/forge-github/src/provider.ts) 展示了每个方法，契约见 [forge 子系统页面](../../../subsystems/forge.zh.md#overview-and-viewed-marks)。
4. 在所有对 `ForgeActionFailure['code']` 做穷举的地方处理 `unknown`：提示需要到主机上核对结果，核对之前不要再次尝试该改动。
5. 运行类型检查；提供方构造的每个快照与检查都设置了新字段、且没有未处理的 `ForgeActionFailure` 代码时即通过。
