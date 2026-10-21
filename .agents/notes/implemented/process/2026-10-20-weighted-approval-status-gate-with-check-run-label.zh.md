# Agent Note: Weighted approval 保留其 commit status 门禁并新增决策 check run

Status: implemented

[English](2026-10-20-weighted-approval-status-gate-with-check-run-label.md) | 中文

## 问题

`weighted approval` commit status 是本仓库分支规则要求的记录，在批准阈值下方时保持 `pending`。commit status 没有 action-required 状态，读者无法区分等待批准与正在运行的工作。把门禁改成 check run 并不可行：该改动后 check run 在 PR head 上以 `success` 完成，REST API 与 `gh pr checks` 都能列出它，而合并框始终把同一上下文报告为 `Expected — Waiting for status to be reported`，两个 PR 需要管理员绕过才能合并。该改动已回退。

## 决定

publisher 继续完全按原样写 `weighted approval` commit status：策略未满足时为 `pending`，满足时为 `success`，安装或评估失败时为 `error`。分支规则继续要求该 status。该行为——包括未满足的策略保持 `pending`——正是[已归档决定](../../archived/process/2026-09-09-blocked-weighted-approvals-remain-pending.md)记录的；本次变更在该门禁旁边新增标签，而不改变门禁。

publisher 为同一次评估额外写一个 `weighted approval decision` check run：策略未满足时为 `action_required`，满足时为 `success`，安装或评估失败时为 `failure`。check run 的标题携带分数或 blocker。分支规则不要求它，因此它从不阻止合并；它在会阻止合并的那条 status 旁边命名被阻止的状态。

每个 head 只保留一个同名 GitHub Actions run：publisher 更新 head 上已有的 run，仅在不存在时创建。setup 阶段对没有 run 的 head 以 `in_progress` 创建，并把已发布的 success 的 conclusion 改写为 `action_required`，因为 GitHub 接受但不执行改回 `in_progress` 的更新。check run 写入失败会被记录，且从不改变 status，因此没有 checks 权限的 token 或 check-run API 失败时，门禁保持 status 写入的结果。publisher 用创建时设置的 `external_id` 标记识别自己的 run，从而排除 workflow job 为同名 job 产生的 check run。它在依赖安装前撤销已发布的 `success`，因为 GitHub 接受但不执行改回 `in_progress` 的更新。

## 验证

[批准策略测试](../../../../.github/review-ownership/check-approval.test.mjs)锁定未改动的 status 状态、策略满足与未满足两种情况下 check run 的 conclusion、阶段写入、通过 conclusion 撤销已发布的成功、每个 head 只有一个 run，以及无效的列表响应。[工作流测试](../../../../scripts/ci-workflow.spec.ts)锁定 `checks: write` 与 `statuses: write` 权限以及 setup 阶段命令。

check run 的限制于 2026-10-20 在本仓库用被回退的尝试实测：`weighted approval decision` check run 在 PR head 上以 `success` 完成，REST API 与 `gh pr checks` 都能列出它，而合并框始终把同一个 `weighted approval decision` 上下文报告为 expected。

## 考虑过的替代方案

**把 check run 作为必需检查。** 见上面的实测：ruleset 不匹配默认分支 workflow 的 token 发布的 check run，门禁无法满足。

**策略未满足时把 commit status 发布为 `failure`。** status 会完成，但改变了必需记录的含义，并把尚未满足且可撤销的条件报告为故障。

**只发布 check run 而不动 status。** status 会保留上一次评估的状态，门禁与标签可能不一致。

**由专用 GitHub App 发布必需 check run。** 由 ruleset 指定 app 的 check run 可以让必需条目本身携带 action-required 结论。本仓库没有具备 checks 权限的 App；有了之后可以把标签移到必需记录上并停用 status。

## 后果

job 在 `pending` 写入与兜底步骤之间结束（例如 runner 丢失，或取消导致最后一步未执行）会让 status 保持 `pending`；这是该 status 既有的表现，不是新增标签带来的回归。评审未完成时，合并框把 `weighted approval` 报告为 pending（门禁），并把 `weighted approval decision` 条目报告为 `action_required`，标题里是分数或 blocker；`gh pr checks` 会列出两者。已发布的 success 通过改写 check run 的 conclusion 撤销，status 继续按未改动的策略状态变化。
