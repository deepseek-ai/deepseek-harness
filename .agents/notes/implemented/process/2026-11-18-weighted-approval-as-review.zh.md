# Agent Note: Weighted approval 改为 approving review

Status: implemented

[English](2026-11-18-weighted-approval-as-review.md) | 中文

## Problem

必填的 `weighted approval` commit status 把审批决定放在 CI 检查组里。它在策略满足前一直是 `pending`，而 issue #6719 记录了后续 `pull_request_target` 运行会让 merge box 停在 `Expected`、同时 API 报告 `success`，导致本可通过的拉取请求继续被阻塞。该 status 还让读者把等待审批当成 CI 正在运行，并用自定义 status 重复了仓库原生的 review 要求。此前加入的 `weighted approval decision` check run 只是给同一状态加了标签，并没有移除 status 门禁或 check suite 关联的竞态。

## Decision

`weighted-approval` workflow 不再写 commit status，也不再写 check run。它用同一套策略计算分数，然后通过 approval App 发布结果：

- 策略未满足时，创建或更新一条带 `<!-- weighted-approval -->` 标记的对话评论。评论列出分数、计入的 approval、剩余点数、阻塞的 change request、仍在等待的委托 review，以及没有写权限的 review。
- 策略满足时，删除该评论并提交带同一标记的 `APPROVE` review。如果最近一条带标记的 review 已经是 `APPROVED`，不再提交第二条。
- Draft、阻塞的 change request 或低于阈值的分数会 dismiss 每一条带标记的 `APPROVED` review，然后发布或保留评论。Draft 永远不会被 approve。
- 评估失败会让 workflow run 失败，不发布部分决定。

发布器自己的带标记 review 不计入分数，因此它不能提供自己正在评估的点数。委托、作者积分、生产代码行归属和两点阈值保持原有规则。

Approval App token 承担所有读写：review、评论、review dismissal、review request 和 GraphQL 编辑者校验。它请求 `Contents: write`、`Issues: write` 和 `Pull requests: write`。GitHub 只在 App 对仓库有写权限时才把 App approval 计入 required review，因此必须有 Contents write；缺失权限会让 token 步骤失败，而不是发布一个无法满足 ruleset 的 approval。

分支规则从 required status checks 组移除 `weighted approval`。单独的 ruleset `Default + release branches — Weighted approval` 在默认分支和 release 分支要求一个 approving review。`Default + release branches — Merge requirements` ruleset 保留合并方式和 review thread resolution，并把 `required_approving_review_count` 设为 `0`。审批要求因此成为独立的 requirement 组，而不是 CI check。

## Verification

审批策略套件用 `node --test .github/review-ownership/check-approval.test.mjs` 运行 82 个 keyless 测试，覆盖评论创建、更新和删除，approving review 的提交与去重，分数回退和 draft 时的撤回，发布器自身 review 从计分中排除，委托、计分和 API 失败。`scripts/ci-workflow.spec.ts` 中的 workflow 测试钉住可信 checkout、无权限的 review 事件转交、App token 权限范围、事件和唯一的评估命令。

线上验收路径要求 App 安装授予 Contents、Issues 和 Pull requests 写权限。本决定合并后，移除已退役的 status 要求，创建单独的 ruleset，并打开一个已有两个 approval 点的拉取请求。App 提交一条 `APPROVE` review，状态评论消失，`gh pr view <number> --json reviewDecision` 报告 `APPROVED`。

## Alternatives considered

**保留 commit status 并加上评论。** 否决，因为该 status 正是要移除的故障：它仍然是阻塞合并的 CI 条目，而且 issue #6719 表明后续 `pull_request_target` 运行仍可能把它渲染为 expected。[归档的 status 门禁决定](../../archived/process/2026-10-20-weighted-approval-status-gate-with-check-run-label.md)记录了实测的 check run 关联结果。

**改为要求 App 发布的 check run，而不是 review。** 2026-10-20 和 2026-10-21 的实测结果：用 workflow token 创建的 check run 会挂到 head 上最早的 Actions check suite；当该 suite 属于 `pull_request_target` 发布器时，merge box 不会列出它；用 job token 发布的必填 check run 一直显示 `Expected`，而 REST API 和 `gh pr checks` 已列出它完成，两个拉取请求因此需要管理员绕过。由 approval App 发布 run 只修正了标签，没有修正要求：审批仍然留在检查组里。

**用 `GITHUB_TOKEN` 提交 approval。** 否决，因为 GitHub 默认阻止 workflow token 提交 approval，而且它们不计入 required review。必须使用独立的 App 身份。

**要求团队 review。** 否决，因为 ruleset 的 `required_reviewers` 只接受团队；审批发布器是 App 安装，不是团队成员。

**同时保留 status 和 review。** 否决，因为两道门禁会把 status 的故障留在原处，并重复报告同一个决定。

## Consequences

任何有写权限的 approval 都满足 required review，包括低于两点的人类 approval。加权分数决定 App 何时提供自己的 approval、评论何时报告缺口；它不再是原生 review 之上的额外合并门禁。因此，维护者若想让低于两点的拉取请求停下，需要显式提交 change request，而不是靠缺少 approval。

Approval App 现在需要 Contents write，比它此前拥有的 Checks write 更宽。由于 stale review dismissal 保持关闭，App approval 会在后续 push 后继续存在；下一次评估会重新检查分数，并在策略不再满足时撤回 approval。GitHub 会拒绝 App 对自己创建的拉取请求提交 approval，因此这类拉取请求需要人类 approval。

移除 status 后，后续 `pull_request_target` 运行不再出现 `Expected` 故障。workflow 自身的 job 不再是必填检查；评估失败会作为失败的 run 出现在拉取请求检查列表中，但不会阻塞已经有 required approval 的合并。
