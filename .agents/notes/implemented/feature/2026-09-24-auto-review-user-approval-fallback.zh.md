# Agent Note: Auto review 拒绝后请求用户审批

Status: implemented

[English](2026-09-24-auto-review-user-approval-fallback.md) | 中文

## Problem

[Auto review](2026-08-28-auto-review.zh.md) 把每次 reviewer 拒绝都当作最终结果，并把每次 reviewer 失败也报告为同样的拒绝。旁观 Session 的人无法让被拒绝的调用继续执行，即使 reviewer 误判了此人想要的动作；唯一的补救是把整个 Session 切换到 Full access。Reviewer 响应不合法、provider 出错或 Session 事实缺失时，模型与用户看到的都是 `Auto review rejected tool "<name>"`，因此两者都无法区分策略决定与技术失败，也无法针对原因采取行动。

## Decision

当 Session 的审批策略为 `ask` 时，reviewer 拒绝返回 tools 流水线既有的 `ask` 决定。`ToolRuntime` 通过审批服务发送该请求，理由为 `Auto review denied tool "<name>"`；reviewer 给出理由时再追加 `: <reviewer reason>`。`allowed-once` 执行调用；`rejected`、`cancelled` 与 `unavailable` 通过审批服务的普通消息拒绝调用，body 不执行。只有后续 `tools/pre-execute` listener 放行调用后，listener 才请求审批，因此下游拒绝或取消优先且不弹出审批。

选择 Auto 会写入 `danger-full-access` 与 `ask` 审批策略。已记录的 Auto 选择也匹配 `never` 策略。[进程内委派 child 固定 `never`](2026-08-10-subagent-approval-pinned-never.zh.md)，因此 child 的 Auto 保留最终的 `AutoReviewDeniedError` 拒绝及其理由；按先前 `never` 组合记录的 Session 仍解析为 Auto，而不是 Full access。再次选择 Auto 会写入 `ask`。

Reviewer 失败以 `Auto review of tool "<name>" failed; its body was not executed: <error>` 拒绝调用，不带结构化错误信息。Provider 失败消息包含 finish 类型、失败代码与 provider 消息，因此模型与通用工具卡片显示实际原因。

## Alternatives considered

**Reviewer 失败后也请求用户审批。** 失败不说明动作风险；请求审批会把技术错误呈现为策略问题，并用反复弹出的审批掩盖损坏的 reviewer 路由。

**始终返回 `ask`，由 `never` 策略拒绝。** 审批服务把该拒绝报告为 `the user rejected tool "<name>"`，这对 child 不成立，而且会丢失 reviewer 理由。

**Auto 保持 `never`，由 reviewer 绕过审批策略。** 审批服务在任何应答者之前执行 `never`，因此没有 listener 能绕过它；模型上下文中的策略文本也会告诉主 agent 不可能发生审批。

## Consequences

- 交互式 Auto Session 可能停在审批提示上，因此 Auto 不再保证无人值守地推进。
- 用户可以在审批提示与审批审计事件中看到原始 reviewer 理由；主模型只看到审批结果。
- Reviewer 失败文本（包括 provider 消息）成为模型可见的工具错误内容。
- 在 Auto 与 Full access 之间切换现在也会改变审批策略，因此存活 agent 的切换路径会排入审批策略变更通知。
- 单元测试覆盖各审批结果、下游拒绝的先后顺序、child 的 `never` 路径以及具体失败消息；shipped Web 组合测试覆盖真实 reviewer 拒绝之后的用户拒绝。
