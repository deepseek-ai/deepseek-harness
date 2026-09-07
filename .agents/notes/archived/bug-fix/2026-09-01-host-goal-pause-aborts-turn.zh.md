# Agent Note: 宿主发起的 goal 暂停中止当前轮次

Status: implemented
Archived: 2026-09-04

[English](2026-09-01-host-goal-pause-aborts-turn.md) | 中文

## 问题

在 Web UI 点击「暂停目标」会把 goal 改成 `paused` 并解除自动续跑的武装（disarmed），但已经在跑的模型轮次不会停止。模型还能继续行动，并在同一个轮次里调用 `update_goal resume`，立刻撤销这次暂停，因此人工暂停对 goal 执行没有真正的控制力。

## 决策

goal round driver 现在会读取每个 `goal/changed` 事件里的 `change`。当 `operation === 'pause'` 且暂停不是由 agent 自己的轮次发起时，driver 用 `agent.cancel({ kind: 'user' }, { keepInbox: true })` 中止当前轮次。Web 按钮运行在任何 agent initiator 边界之外，而模型调用 `update_goal pause` 时当前 initiator 就是该 agent；driver 用 `ctx.agents.currentInitiator() !== agent` 来区分两者。中止是有意放宽的——它会停掉任何正在运行的轮次，而不只是 goal round——因为人工暂停是强烈的「现在停止」信号，仅 disarmed 只能阻止后续轮次，停不掉正在进行的执行。

`keepInbox` 会保留待处理工作。一旦 goal 被 disarmed，已排队的 goal round 就会在既有的 pre-step reservation 校验里失败，因此暂停后不会再运行。

暂停被取消 goal 的 idle 处理器被栅栏限定到被丢弃 attempt 的精确 `{ goalId, revision }`。resume 会推进 revision，因此在被中止轮次收敛到 idle 之前「暂停后立即 resume」会被保留，而不会被过期的 cancelled attempt 再次暂停。

## 考虑过的替代方案

**对每次暂停都中止轮次，包括模型自己发起的。** 否决：响应人类直接请求而暂停的模型应当完成本轮并给出回复；在工具调用中途中止只会截断这层确认，却换不来更多控制力。

**把中止逻辑放进 goal 服务的 `pause`。** 否决：`pause` 是宿主与模型共用的唯一入口，服务里同样需要这个 initiator 判断。把控制处理留在 round driver，可以让 goal 服务保持为持久状态与事件的拥有者。

**把中止限定到真正在跑 goal round 的轮次。** 否决：正在运行的轮次正是用户要求停止的执行，额外的 attempt 状态检查只会增加一条微妙路径，却不改变本 issue 要求的结果。

## 后果

现在 Web 的「暂停目标」会中止正在运行的轮次，模型无法继续行动或在同一轮次里恢复刚被暂停的 goal。暂停后立即 resume 会保留被恢复的 goal 继续运行。模型发起的暂停行为不变。改动局限于 round driver 及其测试；goal 领域、工具授权与持久化格式都不变。
