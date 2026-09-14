# Agent Note: 按文件路径识别审批评审工作流

Status: implemented

[English](2026-09-10-approval-review-workflow-identity.md) | 中文

## 问题

GitHub 可能用展开后的 `run-name` 填充工作流运行的 `name`。审批评审工作流在该标题中包含拉取请求编号，因此将 `workflow_run.name` 与静态工作流名称比较，会在刷新审批状态前拒绝有效的评审事件。

## 决策

[审批发布器](../../../../.github/review-ownership/check-approval.mjs) 按精确的 `workflow_run.path` 识别评审事件工作流。它还要求该运行由 `pull_request_review` 触发且成功完成，从 `display_title` 解析拉取请求编号，验证提供的拉取请求关联，并在计算审批结果前将拉取请求当前的头提交与已评审的头提交进行比较。

## 考虑过的替代方案

**接受名称前缀。** 显示名称无法识别工作流文件；另一个工作流可以使用相同的标题。

**删除带编号的运行标题。** 当 GitHub 返回空的 `pull_requests` 数组时，标题提供拉取请求编号。删除它需要另一种传递机制。

## 影响

运行标题的展开不会阻止审批刷新，而非预期的工作流文件仍无法通过验证。移动评审事件工作流时，需要更新发布器预期的路径。

[审批策略测试](../../../../.github/review-ownership/check-approval.test.mjs) 覆盖带编号的运行名称、无效的来源路径和事件、未成功的运行、无效标题以及已被替代的头提交。[审批结果策略](2026-09-09-blocked-weighted-approvals-remain-pending.zh.md) 继续负责待定与成功状态的语义。
