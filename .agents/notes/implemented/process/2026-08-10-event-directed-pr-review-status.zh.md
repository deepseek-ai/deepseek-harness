# Agent Note: 由事件直接指定的 PR 评审状态命令

Status: implemented

[English](2026-08-10-event-directed-pr-review-status.md) | 中文

## 问题

Issue 所在 Project 中的状态记录了解决工作的下一步由谁负责。PR（Pull Request）的汇总评审状态可以回答 GitHub 是否认为该 PR 可合并，却无法表示这次交接：作者修复代码并重新请求评审后，先前的 `CHANGES_REQUESTED` 评审仍可能继续生效。

单调投影也无法在评审人提出修改要求时，将由自动化管理的 Issue 从 `In review` 退回 `In progress`。重建评审轮次或评审人阻塞项会引入既定双事件约定并不需要的状态。

## 决策

Issue 生命周期工作流把评审 webhook 视为命令。`pull_request.review_requested`（包括重复请求）将目标状态指定为 `In review`。`pull_request_review.submitted` 将目标状态指定为 `In progress`，但仅在 `review.state` 为 `changes_requested` 时生效；submitted 事件仍不可省略，因为评审人即使没有先触发 review-request 事件，也可以直接提出修改要求。对于 approved 和 commented 提交，生命周期作业会运行但空操作（不会走到创建 Project token 一步）；dismissed 评审则不在订阅范围内。

工作流订阅的普通 PR 事件仍是只向前推进的实现信号：它们可以将 `Inbox`、`Backlog` 或 `Ready` 推进至 `In progress`，但不能让 `In review` 倒退。请求评审命令可将任意较早的活跃状态推进至 `In review`。请求修改命令可将较早的活跃状态推进至 `In progress`；它也可以让 `In review` 状态回退，但仅在目标 Project 的最新状态事件由配置的生命周期执行主体写入时进行。若最新状态事件的执行主体是人工用户或未知主体，则保留当前状态。

状态投影仅解析同一仓库内严格匹配的 `Fixes`、`Closes` 或 `Resolves` 引用。它不会更改终态、将没有 Project 状态的 Issue 添加到 Project、依赖 PR 元数据是否有效、查询 `reviewDecision`、重建评审轮次、从 Issue 反向查找 PR，或运行定时协调器。独立的日期初始化由[Project 局部 Issue 规划字段](2026-09-02-project-local-issue-planning-fields.zh.md)负责，并处理每个同仓库 Issue 引用。

[Issue 生命周期](../../../../.github/workflows/issue-lifecycle.yml)仍不订阅 `pull_request.ready_for_review`；两条事件命令均不依赖该动作。[Issue 策略](../../../../.github/workflows/issue-policy.yml)保留 `ready_for_review`，因为人工提交的 PR 进入评审时，该工作流负责执行必需检查门禁。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)锁定事件到命令的映射、请求修改命令后重复请求评审所触发的状态转换、请求修改后的状态回退、终态保护，以及保留人工覆盖状态。[工作流测试](../../../../scripts/ci-workflow.spec.ts)锁定订阅事件、job 级无 `if` 且 token/看板步骤带 step 级门控（使 approved/commented 评审以 pass 呈现且不铸 token），以及独立的 `ready_for_review` 策略触发器。

## 考虑过的替代方案

**根据 `reviewDecision` 或重建的评审轮次派生状态。** GitHub 的汇总状态在重复请求评审后仍可能保持为 `CHANGES_REQUESTED`，而轮次归约器会引入超出两个显式交接动作所需范围的评审人语义和顺序语义。

**保留只向前推进的投影。** 单调推进可保护较后的状态不被回退，但作者正在按要求修改代码时，Issue 会一直停留在 `In review`。

**无条件应用每条评审命令。** 这是最精简的事件处理器，但会让自动化覆盖由人工管理的 Project 状态。因此，处理器通过目标 Project 最新状态事件的执行主体保护唯一允许的回退转换。

**恢复 `ready_for_review` 或添加防抖队列。** Ready 状态并不表示两种评审交接中的任何一种；新增队列只会增加延迟和控制平面状态，不会改变任一命令。

## 后果

即使 GitHub 仍报告一个较早的阻塞性评审，重复请求评审也会将正由当前 PR 解决且由自动化管理的 Issue 推进至 `In review`。后续提出修改要求的评审会将其退回 `In progress`；批准、评论、撤销评审、推送和移除评审人都不会改变最近一条命令设定的状态。

投影仍由事件驱动；如果某个事件从未触发工作流运行，投影不会自行修复。回放旧的工作流运行可能会再次执行其中的旧命令；ProjectV2 仍不提供在读取最新状态与执行变更之间进行原子比较并交换（compare-and-swap）的能力。以单个 PR 为粒度的工作流并发控制和人工状态所有权保护机制可减少这些竞态，而无需引入持久化生命周期状态。
