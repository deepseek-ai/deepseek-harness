# Agent Note: 阻塞中的加权批准保持 pending

Status: implemented

[English](2026-09-09-blocked-weighted-approvals-remain-pending.md) | 中文

## 问题

`weighted approval` commit status 必须区分尚未满足的合并条件与失败的策略评估。具有写权限的评审人所提交且仍然生效的 `CHANGES_REQUESTED` 评审会阻止 PR 满足批准策略，但它是一种可撤销的评审状态，而不是评估故障。

为这种评审状态发布 `failure` 会混淆批准决策与 publisher 的健康状态。它还会让一个尚未满足的策略条件区别于 draft PR 或批准点数不足；后两种情况在贡献者能够解决问题期间会保持 pending。

## 决策

完成的加权批准评估会在 PR 为 draft、批准点数少于要求，或具有写权限的评审人存在仍然生效的 `CHANGES_REQUESTED` 评审时发布 `pending`。阻塞性评审的优先级高于点数总和，因此即使计入的批准已经达到阈值，状态仍保持 pending。

只有在 PR 已进入 ready 状态、达到点数阈值且不存在阻塞性评审时，评估才发布 `success`。独立的 `weighted approval publisher` Actions job 报告评估和状态发布是否完成。评估故障会发布 `error` commit status，并使该 job 失败。

## 验证

[批准策略测试](../../../../.github/review-ownership/check-approval.test.mjs)锁定已达到阈值但仍有 blocker 的场景，以及准确发布的 `pending` payload。[工作流测试](../../../../scripts/ci-workflow.spec.ts)锁定独立的 publisher job 名称。

## 考虑过的替代方案

**为阻塞性评审发布 `failure`。** 该方案会在评审改变之前保持明显的失败状态，但它会把尚未满足且可撤销的合并条件表示为故障，并混淆策略结果与 publisher 的健康状态。

**允许批准点数覆盖阻塞性评审。** 该方案会让分数成为唯一的成功条件，但也允许在具有写权限的评审人仍然有效地要求修改时发布成功状态。

## 后果

需要该状态的分支规则会阻止 PR，因为 `pending` 不满足必需状态。贡献者可以区分尚待处理的评审工作与失败的批准评估，而 publisher job 和 `error` 状态保留运行故障信号。

消费方不会仅因存在阻塞性评审而收到失败的 commit status。如果需要区分 blocker 与其他 pending 批准条件，它们必须检查状态描述或仍然生效的评审。
