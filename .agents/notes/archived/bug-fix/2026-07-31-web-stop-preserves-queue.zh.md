# Agent Note: Web 停止操作保留待处理 Queue

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-web-stop-preserves-queue.md) | 中文

## 问题

Web 停止按钮调用 `session.cancel`，后者映射到广义 `agent.cancel({ kind: 'user' })`。在活动轮次期间，普通 composer 提交已经被接纳为可独立寻址的 Queue 入队项。用户只想停止当前生成时，广义取消却会丢弃所有入队项，混淆了轮次中断与 Queue 的显式删除操作。

浏览器无法通过重发可见行修复这一损失。它不拥有这些行的实时 `InboxItemId`、唤醒策略或认领竞态；重发还可能重复 Host 已认领的工作。

## 决策

`session.cancel` 是 Web Host API 面向普通会话的活动轮次停止操作。它会以 `agent-busy` 拒绝由会话支撑的 subagent；否则会调用 `agent.cancel({ kind: 'user' }, { keepInbox: true })`，在协作式中止当前轮次的同时保留待处理 inbox 工作。底层选项会保留 queued 和 steering 入队项；Web Queue 投影继续只暴露 queued 入队项。

AgentLoop 不会启动并发的替代轮次。它会关闭并 flush 被中断的轮次，达到取消的完全停稳，然后通过现有 FIFO 驱动器认领下一个可唤醒的 queued 入队项。该认领会发出 `agent/inbox/dequeue`，因此 Host 的权威 `session/queue` 快照会退役已认领行，并使剩余队尾保持可见。浏览器既不重发，也不提升任何行。忽略取消的工作会延迟这一交接，直到该工作结算。

该映射只更改 Web 客户端使用的 Host `session.cancel` 端点。`Agent.cancel()` 默认约定仍为广义取消，ACP 和 TUI 保留既有取消策略，`AgentHandle.dispose()` 在拆卸期间仍会清除待处理工作。移除 Queue 行仍是用于丢弃单个待处理入队项的显式 Web 操作。

## 考虑过的替代方案

**停止按钮继续使用广义取消。** 之所以否决：停止一次生成不应销毁已独立排队的用户意图；Queue 已拥有显式删除操作。

**取消后由浏览器重发下一行。** 之所以否决：Host 拥有入队项标识和认领顺序。客户端重新提交可能重复工作、重排 FIFO，或与权威出队产生竞态。

**被取消工作达到完全停稳之前启动下一轮次。** 之所以否决：两个轮次会并发修改同一会话日志，并共享 Agent 拥有的资源。协作式取消会如实等待活动工作结算。

**为广义取消与保留式取消添加协议选项。** 之所以否决：在 Web 产品提供独立的「停止并清空 Queue」交互之前，不需要此选项。现有停止按钮只有一项策略，而逐行删除已提供当前的丢弃控件。

## 验证

AgentLoop 覆盖会保持一个活动模型流，将两个可唤醒轮次排队，使用 `keepInbox` 取消，并固定验证先中止、后完成的轮次原因，FIFO 用户消息顺序，不存在 discard 事件，以及最终空闲状态。无密钥 Web 场景通过 HTTP／SSE 驱动已组装组合：它停止一个卡住的轮次，观察队尾保持可见时下一个 queued 入队项开始，再停止该轮次，并观察最后一个 queued 入队项完成。其可访问性快照固定了中间的 Queue 保留状态。

## 后果

Web 停止会保留已接纳的排队意图，并在取消如实结算后自动推进。不配合取消的活动工作收尾时，Queue 行可能仍保持可见；由同一 inbox 选项保留的外部 steering 可以进入下一个已接纳轮次，尽管 Web 不会在 QueueDock 中渲染 steering。未来的批量清空交互需要显式的产品操作，而不是过载停止。
