# Agent Note: 请求错误重试动作

Status: implemented
Archived: 2026-09-30

[English](2026-07-27-request-error-retry-action.md) | 中文

## 问题

模型请求恢复由 `agent/request-error` 内部决定，却通过 `Agent.retry()` 传达。这个公开命令只在一个狭窄的 waterfall（瀑布式事件）窗口内和空闲时有效，在其他运行状态下会被拒绝，并要求 `ReactLoopAgent` 在 waterfall 结果旁保留一个可变的重试窗口。恢复插件是仅有的生产调用方，因此更宽泛的活跃 agent（智能体）能力暴露了与其策略决策无关的状态与行为。

## 决策

`agent/request-error` 返回 `RequestErrorAction`，其中负责处理的动作是 `{ kind: 'retry' }`；默认的 `undefined` 会让失败轮次保持终态。不拥有该失败的监听器调用 `next()`。拥有该失败的监听器执行所有需要等待的修复，然后直接返回重试动作而不继续委托。

waterfall 结算后，循环读取该动作，关闭失败轮次，并从持久历史开启一个重试轮次。循环在使用该动作时会再次检查轮次信号，因此即使监听器随后返回重试动作，恢复期间发生的取消或 dispose（资源释放）仍会阻止重试。抛出异常的恢复不会产生动作。

`Agent` 与 `ReactLoopAgent` 均不暴露 `retry()` 方法。普通新工作通过 `followup()`、`steer()` 和 `inject()` 进入；只有已处理的模型请求失败才能开启没有提示词的重试轮次。

## 曾考虑的替代方案

**保留 `Agent.retry()` 作为恢复命令。** 运行时防护检查可以将该命令限制在请求错误窗口内，但接口仍会暴露一个没有生产消费方的空闲无提示词再运行操作，循环也仍需通过可变的旁路状态取回已由 waterfall 承载的决策。

**返回显式终态动作。** `undefined` 已经表示 waterfall 未处理时的默认值，并可直接通过 `next()` 组合。再添加一个 `{ kind: 'fail' }` 值不会提供不同的行为或归属信息。

## 后果

恢复归属、异步修复和重试决策共用一条类型化返回路径。活跃 agent 接口与具体循环不再具有空闲无提示词再运行能力和重试窗口状态。调用方如果不提交后续提示词，就无法重启任意失败的非请求工作；瞬时策略与上下文溢出策略则保留编号重试轮次、从持久历史重建、有限的策略私有预算和取消优先级。

聚焦的 agent-loop 测试固定了重试链、未处理失败保持终态、恢复失败和取消竞态。llm-retry 与 compaction-basic 测试套件固定其策略自有的动作返回，而 ACP（Agent Client Protocol）、goal-round-driver 和 plan-mode 集成测试固定后继轮次承接。
