# Agent Note: 空输入时 Cmd/Ctrl+Enter 将 Web 排队消息全部插话

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-web-queue-steer-all-gesture.md) | 中文

## 问题

主会话运行时，用户用普通 Enter（或在 busy-Enter 偏好为 Queue 时）输入的消息会在 Web 队列里累积。把它们灌进当前轮次需要逐条点击「插话发送」按钮；而输入框草稿为空时没有任何键盘手势——输入机对空草稿直接拒绝，Enter 与 Cmd/Ctrl+Enter 都是空操作。排队消息一多，逐条插话是明显的多点摩擦，空草稿 + 加速 Enter 正是「全部插话」的自然位置。

## 决策

空草稿的 Cmd/Ctrl+Enter 现在会把仍在排队（`placement: 'queued'`）的 Inbox 行按 FIFO 顺序全部插话进运行中的轮次，仅限报告 running 的主会话。手势在 `InputBar.onKeyDown` 解码：加速 Enter + 去空白后为空草稿 + `running` + 无 subagent 地址 + 至少一条 `queued` 行时，改走新的 `ComposerKeyboard.steerQueue()` 动词而不是 `submit()`。`SessionInputShell.steerQueue()` 委托给 hub 编排的流程：重新读取权威的 `session/queue` 快照，过滤 `placement: 'queued'`（pending steering 行已经在本轮内），并逐条顺序执行 Queue 面板的严格 steer 操作 `session.updateQueue(itemId, { kind: 'steer' })`，从而在 host 侧保证 FIFO 顺序。`steer-unavailable`（flush 中途轮次关闭）或 `queue-item-not-found`（行已被占用）静默收敛；其他失败弹出一条 composer 通知（「插话发送失败，请重试。」）。无 wire、磁盘或 agent-loop 改动：严格 steer 边界本来就在 host 侧。

该手势严格限定为加速组合键。空草稿 + 普通 Enter 仍然无操作（即使 busy-Enter 偏好为 Steer）；草稿内容优先于队列（加速 Enter 只插话当前草稿）；idle 或 subagent 会话保持原有空草稿无操作，因为没有可插入的运行中轮次。

同一套计算得出的可用性门控也负责提示该手势：当草稿为空、输入框未锁定且不处于瞬态机器锁（adjudicating/submitting）、命令菜单未打开、普通主会话正在运行且至少一行仍为 `queued` 时，文本框 placeholder 会提示 Cmd/Ctrl+Enter 将全部排队消息插话发送。owner 提供的 placeholder 仍然优先；可用时 steer 提示会刻意优先于 plan 模式 placeholder（该窗口内手势确实可用）。

## 后果

一个键盘手势替代 N 次点击，同时保持单一严格 steer 路径与单一收敛权威。逐条按钮与手势是同一个 host 操作，竞态与失败语义完全一致。手势及其 placeholder 共用一个呈现层门控；hub 在执行时会重新读取快照，因此客户端门控仍只是建议性的，host 仍是权威。

## 相关决策

逐条「插话发送」动作及其严格 steer 边界由 [将一条 Web 排队消息插话到活动轮次](../feature/2026-07-30-web-queue-steer-action.zh.md) 记录；本笔记只在其之上增加整队列键盘手势。

## 曾考虑的替代方案

- **在输入机内拦截。** 已拒绝：输入机按设计不感知队列（队列投影由 wiring 层叠加），且无法区分加速 Enter 与必须保持空操作的普通 Enter。
- **逐条用 `session.prompt(mode: 'steer')` 插话。** 已拒绝：那会铸造新消息而不是转移 pending 行，破坏 dock 的不可变消息契约；`updateQueue({ kind: 'steer' })` 已经原子地转移了确切的那条。
- **并发触发所有行。** 已拒绝：host 到达顺序无法保证，而插话顺序对模型可见；顺序 await 保证 FIFO。
- **为 steer-all 新增 host RPC。** 已拒绝：现有逐条操作已足够幂等——每行一次严格 steer，中途关闭静默收敛——协议改动没有收益。
- **发送按钮 tooltip。** 已拒绝：主按钮在空草稿的运行窗口内是 Stop，而这也正是整队列手势唯一可用的窗口。placeholder 恰好在该窗口显示，可以直接说明这项键盘操作。
