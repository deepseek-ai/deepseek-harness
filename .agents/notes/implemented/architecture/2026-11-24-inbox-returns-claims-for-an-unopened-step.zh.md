# Agent Note：Inbox 放回尚未开启的步骤所领取的消息

Status: implemented

[English](2026-11-24-inbox-returns-claims-for-an-unopened-step.md) | 中文

## 问题

AgentLoop 在提示词组装和 `agent/pre-step` 之前领取 inbox 输入。如果其中任一环节失败、用户停止 Agent，或者进程在 `step/start` 之前退出，这批消息已经离开 inbox，也没有 `user/message` 记录它。#5655 报告的是用户场景：第二条提示触发压缩时按 Stop，那条提示就丢了。#8700 和 #8721 报告的是投递方场景：子 Agent 结果、定时提醒、ACP 提示和 goal 回合以同样的方式消失。所有 inbox 投递方共用一个恢复责任方，也就是 inbox 本身，因为 headless、ACP、SDK 和访客投递方都不保留自己排入的输入副本。

## 决策

**`inbox` 投影从同一组 splice 折叠出队列和领取记录。** 领取时写入的 splice 只记录 `start` 和 `removedCount`，不记录被移除的消息，所以只有重建队列的那份折叠逻辑能说出领取的是哪一批消息。投影状态为 `{ queues: { 'next-turn', 'next-step' }, claim: { pending, interrupted } }`。`queues` 保持为一个对象，因为 wire view 按引用返回它，只改领取记录时就不会重复发布。`claim` 采用同样的分组。状态转移如下：

| 事件 | 本次修改前 | 现在 |
| --- | --- | --- |
| `agent/inbox/spliced`，队列更新 | 校验 `start` 和 `removedCount`，对目标队列做 splice，拒绝同一身份重复排队 | 不变 |
| `agent/inbox/spliced`，移除且没有 `outcome` | 只更新队列 | 被移除的消息按队列顺序追加到 `claim.pending` |
| `agent/inbox/spliced`，`outcome: 'canceled'` | 只更新队列 | 被移除的身份从 `claim.pending` 和 `claim.interrupted` 中移出，除非同一条 splice 又把它插回 |
| `step/start` | 忽略 | 清空 `claim.pending` |
| `turn/end` | 忽略 | 清空 `claim.pending`；reason 为 `interrupted` 时把它移到 `claim.interrupted`，其他 reason 两者都清空 |
| 带 `inherited: true` 的 `session/end-seed` | 忽略 | 两个领取列表都清空：fork 继承父会话的队列，但不继承父会话轮次留下的未开启领取 |
| 其他事件 | 同一引用 | 同一引用 |
| Wire view | 整个状态 | 按引用返回 `queues` |

Host 检查点以 `stateVersion` 3 保存完整状态；版本 1 或 2 的行从日志重放。

**由 inbox 负责放回。** 轮次在 `step/start` 之前结束时，循环在记录 `turn/end` 之前调用 `inbox.returnClaims()`，由 inbox 决定：`clear()` 把当前领取记为已放弃，`claim()` 重置这个标记，因此清空队列的 Stop 会丢弃这批消息，保留队列的 Stop（`keepInbox`）会把它们按领取顺序放回 next-turn 队首，跳过已经在队列中的身份。Session 拒绝放回时通过 `agent/error` 报告；`turn/end` 仍记录原始失败并落定这次领取。循环自己不持有任何放回状态。

**恢复时在 `agent/created` 之前放回被中断的领取。** `announce()` 让 Session 可写之后，AgentLoop 调用 `inbox.restoreInterrupted()`，不看创建来源：只有恢复修复把 `turn/end` 记为 interrupted 之后 `claim.interrupted` 才非空，所以新建 Session 时这一步什么也不做。fork 时同样什么也不做：冷读崩溃的父会话会在继承前缀内把未关闭的轮次记为 interrupted，折叠逻辑在带 inherited 标记的 `session/end-seed` 处清空两个领取列表，子会话因此保留父会话的队列，但不保留父会话已经取出的输入。`session/created` 监听器不能承担这件事，因为派发期间 Session 是只读的。

**拥有请求或重试的投递方撤回自己被放回的输入。** ACP 撤回已结算请求的提示，goal 驱动撤回没有有效预约的回合，schedule 恢复让被放回的提醒留在队列里，不移动它也不占用它的时段。子 Agent 管理器把只剩放回输入的子 Agent 视为已结算，而非停放。

## 考虑过的替代方案

**只保存 `pending` 和 `interrupted` 的平行投影。** 它必须自己重放队列才能知道一次领取移除了哪些消息，于是每个 Session 都有两份队列折叠逻辑和两份队列检查点，修改 splice 时两处都要改。改为让 splice 事件携带被移除的消息，则每条消息都会在日志里重复一份。

**平铺的投影状态。** 四个并列字段更好读，但 wire view 必须在每次状态变化时新建对象，于是每次 `step/start` 和 `turn/end` 都会向所有客户端重复发布内容相同的 inbox；在 view 里缓存引用的代价比分组更大。

**错误钩子，或在准备前写 `user/message`。** 钩子无法在进程退出后恢复领取。在请求准备前提交 `user/message`，用户在准备期间停止时历史里会留下一条没有回答的提示。

**只在失败时放回，任何取消都丢弃。** 压缩期间按 Stop 正是 #5655 报告的情形；把它当作对消息的否决会让那条消息继续丢失。`keepInbox` 已经把 Stop 和清空分开。

**由各投递方放回（#8741）。** 这个方案只能放回 Web 提示：headless、ACP、SDK 和访客都不保留输入副本。由 inbox 放回时，恢复成为默认行为，有自己处理方式的投递方再撤回。

**放回各自离开的队列。** 放回 next-step 的 steer 在队列面板里看不见，会随下一条消息一起运行而没有编辑或删除的机会；它要插入的那一步已经随轮次结束。next-turn 是拥有者看得见的地方。

**在循环的运行阶段上放一个放回标志。** 循环曾记录取消是否保留 inbox，并在结束轮次的 catch 里读取它。这个事实属于 inbox，它本来就能看到 `clear()` 和 `claim()`；而且这个标志每个 driver 只消费一次，却被当作状态使用。出于同样的理由也考虑过用 inbox 持有的恢复函数包住步骤循环；它只是把这一次调用挪进闭包，决策并没有挪动，代价是整个循环重新缩进，循环的出口也要改走返回值。

## 验证

- [agent-loop/tests/inbox-projection.spec.ts](../../../../packages/core/agent-loop/tests/inbox-projection.spec.ts)：上表每行一个用例，另有同一引用的结果、只改领取记录时 view 复用引用、拒绝非法 splice，以及从版本 1 和 2 的检查点重放。
- [agent-loop/tests/inbox-settlement.spec.ts](../../../../packages/core/agent-loop/tests/inbox-settlement.spec.ts)：保留队列的 Stop 和失败的 pre-step 放回整批且不唤醒 Agent；清空队列的 Stop 丢弃它；`step/start` 之后失败时整批保持落定；拒绝放回时报告该失败，轮次仍以原始失败关闭；新建 Agent 不记录放回；fork 崩溃的父会话时保留父会话的队列而不放回其领取。
- [agent-loop/tests/cancel.spec.ts](../../../../packages/core/agent-loop/tests/cancel.spec.ts)、[loop.spec.ts](../../../../packages/core/agent-loop/tests/loop.spec.ts)、[interception.spec.ts](../../../../packages/core/agent-loop/tests/interception.spec.ts)：放回的提示排在后来输入之前，下次唤醒先运行它。
- [agent-loop/tests/resume.spec.ts](../../../../packages/core/agent-loop/tests/resume.spec.ts)：被中断轮次领取了提示的恢复日志在 `agent/created` 之前放回它一次，排在之后排队的输入前面。
- [子 Agent 测试](../../../../packages/subagent/subagent/tests) 覆盖空闲子级携带放回输入继续驻留。[ACP 测试](../../../../packages/acp/acp/tests/turns.spec.ts) 覆盖返回失败的提示在下次唤醒时运行。[Headless](../../../../packages/bundle/headless/tests/terminal-failures.spec.ts) 和 [SDK](../../../../packages/sdk/server/tests/wait.spec.ts) 测试覆盖下次唤醒处理放回的子 Agent 结果和 SDK 提示。[SDK 恢复测试](../../../../packages/sdk/server/tests/resume.spec.ts) 覆盖首条提示因过时的 goal 回合而继续排队。

## 影响

- `step/start` 之前失败时，已领取的整批消息留在 next-turn 队首；队列面板显示它，下次唤醒按顺序运行。步骤一旦开始，这批消息即已落定，即使请求准备在消息进入历史前失败也一样。
- 每次唤醒都在步骤开始前失败的消息留在队首，直到原因修复或拥有者移除它，期间到达的输入会和它一起被领取并放回。
- 后续一次投递持续处于到期状态时，schedule 恢复逻辑可能反复唤醒已放回的提醒。
- 循环的轮次代码只包含一次 `returnClaims()` 调用，不持有 inbox 恢复状态。
