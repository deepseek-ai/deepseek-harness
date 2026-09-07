# Agent Note: 锁存取消收敛窗口内到达的唤醒请求

Status: implemented

[English](2026-08-07-cancel-convergence-wake-latch.md) | 中文

## 问题

`Agent.cancel(cause, { keepInbox: true })` 在触发 abort 信号后立即返回，但活动 driver 可能尚未收敛到 `idle`：LLM（大语言模型）流拆除、工具取消与 `turn/end` 落盘都会在 `abort()` 返回后异步展开。在该窗口内到达的唤醒 send 被放入 `next-turn`，而 `wakeDriver()` 对仍处于 `running` 的 phase 直接返回，退出的 driver 也从不重放这次唤醒——消息会一直停放到下一条唤醒 send 到达。被中止的 `runMaintenance` 活动周围也存在同样的唤醒丢失窗口。多个测试固化了停放行为（「等待下一次唤醒」）；该缺陷同时破坏了 `session.cancel` 与 `subagent.interrupt` 组合路径（issue #1838）。取消与发送约定由以下既有决策定义：[显式轮次取消](../architecture/2026-07-16-explicit-turn-cancellation.zh.md)与[统一发送](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md)；生产环境中的 `keepInbox` 消费方是[Web 停止保留队列](../../archived/bug-fix/2026-07-31-web-stop-preserves-queue.md)。

## 决策

`running` phase 携带 `wakeRequested` 锁存，与既有的 `maintenance` phase 字段对称。`wakeDriver()` 在当前活动无法投递唤醒时锁存——maintenance 任务从不读取队列，被中止的活动收敛后不会重启——而存活的 driver 不需要锁存，因为它自己会认领排队的工作。退出中的活动在其自身收敛边界（`kick` 的 `finally` 与 `runMaintenance` 的 `finally`）重放锁存：这一位置保证 `turn/end N` 先于重放 driver 打开 `turn/start N+1` 落盘，并保证 `whenIdle()` 通过其 `activityDone` 循环看到重放 driver。两个重放点仅在 `inbox.hasPending` 时执行，因此收敛前被从 inbox 移除的锁存唤醒不会启动空 driver。而 agent（智能体）已处于 idle 时发送的唤醒，即使消息在 driver 认领前被清除，仍会打开自己的轮次边界——这趟 `idle → running → idle` 转换是可观察约定：目标会话 driver 的 pause/disarm 回退依赖取消预订后的 `idle` 转换触发（把守卫放进 `wakeDriver()` 会抑制该边界）。不带 `keepInbox` 的 `cancel()` 会连同 inbox 一起清除锁存。

`signal.aborted` 这一判别条件至关重要：它区分「中断前已排队的工作」——`keepInbox` 将其停放以待后续唤醒（`keepInbox` 停放约定）——与「abort 后显式的唤醒」，后者必须在收敛后执行。

## 备选方案

**让 `cancel()` 立即把 phase 置为 `idle`。** 不予采用：driver 仍在展开收尾，这会重叠两个 driver。重放逻辑位于旧 driver 的 `finally`，而该 `finally` 此后不再执行——83 个测试中有 14 个失败，多个死锁。修复它需要基于身份的 phase 所有权外加轮次开启时的完全停稳屏障，机制上严格更重，而且整体上只是换了个形态的锁存。

**对每个非 idle 唤醒无条件锁存。** 不予采用：中断前的唤醒会在 `keepInbox` 取消后自动启动，违反 `keepInbox` 停放约定；「停放排队工作」测试与错误窗口的 steering（中途引导）测试双双失败。

**通过链式 promise（`activityDone.then(...)`）重放。** 不予采用：重放会运行在活动自身结算之外，`whenIdle()` 的循环可能在重放 driver 启动前就 resolve；修复它需要在 send 时同步替换 `activityDone`，并依赖微任务反应顺序——比同步 flag 更脆弱。

**在 subagent（子智能体）适配器中等待完全停稳。** 因 issue 范围而不予采用：修复由取消/唤醒状态机拥有，而不是消费方。

## 影响

`running` phase 新增 `wakeRequested` 字段；不带 `keepInbox` 的 `cancel()` 会连同 inbox 一起清除它，且 `disposed` 取消从不锁存——dispose（资源释放）开始后到达的唤醒保持停放，`whenIdle()` 不会在拆除中的会话上等待一个完整模型轮次。落在 driver 最后一次 `hasPending` 检查与退出之间不到一个微任务的间隙的唤醒仍会停放——没有锁存触发，因为 phase 是 `running` 且未 abort；关闭该间隙需要无条件锁存，刻意不纳入范围。在被中止的轮次与重放 driver 之间，状态转换会发出一次瞬态 `idle → running` 对。唤醒 send 的消息在任何 driver 认领前被清除时，仍会打开一个已完成的空轮次，保留可观察的唤醒边界。
