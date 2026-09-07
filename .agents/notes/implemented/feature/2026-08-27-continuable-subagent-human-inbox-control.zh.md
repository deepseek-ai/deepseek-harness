# Agent Note: 可继续 subagent 的人类 inbox 控制

Status: implemented

[English](2026-08-27-continuable-subagent-human-inbox-control.md) | 中文

## 问题

可继续子级与普通 Agent 使用相同的 agent loop（智能体循环）和 inbox，但人类投递路径只公开 FIFO 后续轮次。Client 选择专用 subagent prompt Remote 时会丢弃既有的 Queue／Steer 选择，通用 Session ownership fence 又拒绝 subagent 所有身份的全部 queue 变更。因此，浏览器隐藏了在线子级 inbox 已经支持的控制。

无差别开放通用 Session 控制会削弱 subagent 所有权规则。Prompt 投递仍需要确切在线直接父级鉴权与冷恢复记账，而 queue 变更必须拒绝一次性、未知、损坏和冷子级。child 自身 log suffix 中的有效 continuable descriptor 可标识哪些在线 subagent-owned Session 能使用 occurrence mutation。Settlement 还必须在 idle Agent 仍有会被 driver 认领的待投递工作时保留该 Agent，也不得拆除在 `whenIdle()` 兑现后才占用 idle 阶段执行 maintenance 任务的 Agent。

## 决策

在线可继续子级公开普通的人类 inbox 控制，不增加另一套 queue、Remote endpoint、queue action 或面向 Host 的 subagent 操作。一次性子级继续只读。

现有 `SubagentPromptRequest` 携带 `delivery: 'queue' | 'steer'`。Client 把 `Session.prompt(content, mode)` 已选出的 mode 经 `subagent.prompt` 原样转发。Remote 仍要求确切在线直接父级，随后使用一个包内 continuation manager 投递操作。Queue 调用 `Agent.followup(message)`；steer 调用 `Agent.steer(message)`。两条路径共享 child lock、冷恢复、最终父级重新鉴权、调用方 signal 截止、`MessageId` 创建、回滚与 dispose 竞态处理。该人类选择不新增公开调度方法或模型工具；由其他决策拥有的 `sendMessage()` 与面向模型的 `send_message` 操作保留固定的相邻 Agent Steer 语义。

浏览器为可继续子级提供普通的繁忙态 Enter／Cmd+Enter Queue／Steer 偏好、QueueDock Edit／Remove／Steer 操作，以及空草稿 steer-all 手势。Send 与 Stop 继续是独立控制。Composer prompt 会创建新的已准入工作，因此仍要求在线父级。QueueDock 变更直接寻址已经在线的 inbox 工作，所以父级离线时仍可使用；父级离线的 composer 继续锁定。

现有 `session.updateQueue(itemId, action)` 会解析确切在线 Agent，并且只有 subagent-owned Session 的当前 projected identity 为 continuable、descriptor 序号属于 child 自身的非 seed suffix 时才会准入。在线 one-shot Agent 以及缺失、仅继承或无效的 identity 都会继续触发所有权失败。Agent 不存在时返回 `queue-item-not-found`，且不会冷恢复子级。对在线 inbox occurrence 变更而言，目标 Session id 已是充分的人类权限；无需 parent 地址。Edit 与 Remove 保留既有完整 `nextTurn` 和 `nextStep` 语义，包括插件注入的 context；Steer 要求排队 occurrence，且 command 开始时 Agent 必须报告 running。

Continuation manager 不保留第二套消息 reservation 状态。一个私有 `SubagentInbox` 会把 Queue 与 Steer 委托给 Agent inbox，并持有 Activation 既有的 closing promise。自然结算会等待 `Agent.whenIdle()`、child Inbox 为空以及所拥有的每个子级完成 dispose。管理器会在 child lock 内确认 Inbox、owned-child set 与 wake generation，再在准入保持开放时 flush 最终 Session 状态。最终 child-lock 决策会重新验证 Session 序号与相同的驻留事实，然后同步启动一个 `Agent.runMaintenance()` 任务；该任务的入口会占用 idle 阶段，并在同一个 JavaScript turn 内关闭包装层。每个待处理 Inbox occurrence 都会保留 Activation，无论其投递模式或来源如何。由 manager 所有的投递、Inbox claim 或 discard，以及所拥有子级的释放都会更新 wake generation。flush 期间直接接受的 Agent 工作要么改变最终 Session 或驻留观察，要么保持活跃并阻止最终 maintenance 任务启动，要么在重验前完成。

QueueDock Steer 在 command 准入一个正在运行的排队 occurrence 后，采用 Agent 的 best-effort 投递。如果排队 occurrence 先被 claim，`queue-item-not-found` 表示其普通 Queue 投递已经开始。如果活跃取消在同步转移期间先发生，Agent steering 会把消息追加到 `nextTurn`、锁存唤醒，Session command 仍然成功。在该 fallback 情况下，选中消息会移到 Queue 剩余项之后。新组合的 Steer 使用同样的 fallback，错过最近步骤时仍保证可投递。

本决策部分取代 [Web subagent 目录与人类 continuation](2026-07-27-web-subagent-conversations.zh.md)、[可继续 subagent](2026-07-28-continuable-subagent-conversations.zh.md)、[Steer Web 已排队消息](../../archived/feature/2026-07-30-web-queue-steer-action.md)和[用空草稿 Cmd/Ctrl+Enter steer 整个 Web queue](../../archived/feature/2026-08-06-web-queue-steer-all-gesture.md)中的人类控制排除项。活跃记录拥有目录鉴权与 Activation 生命周期；归档记录保留最初的 QueueDock Steer 与手势决策。

## 考虑过的替代方案

**新增 `SubagentRuntime.steer()` 与 Remote。** 拒绝，因为人类 prompt 投递已经拥有带 mode 的 Client 方法和一个已鉴权 Remote。新的公开操作会扩大 service 与模型相邻接口，却不增加执行原语。

**新增 `subagents.updateQueue`。** 拒绝，因为 `session.updateQueue` 已经拥有准确 inbox occurrence 变更及其竞态失败。Projected continuable identity 提供狭窄的 ownership-fence 例外，无需新增操作。

**把所有 subagent 控制都路由到通用 Session API。** 拒绝，因为 prompt 与取消需要 subagent 血缘鉴权、冷恢复记账与专用失败映射。只有在线 inbox occurrence 变更拥有足够的目标本地状态，可使用狭窄的 ownership-fence 例外。

**把可继续 queue 变更限制在 `nextTurn`。** 拒绝，因为人类 inbox 对齐有意包括编辑或删除待处理 steering 与注入 context。如果插件需要围绕其 `nextStep` 输入建立更强事务，该保护应属于共享 Agent inbox 语义，而非 subagent 专属限制。

**按 `MessageId` 跟踪唤醒工作，并在 mutation 中转移该记录。** 拒绝，因为这会用第二套活动账本重复 Inbox 的待处理集合，并让驻留依赖 occurrence 身份。`whenIdle()` 会等待既有 Agent 活动，`Inbox.hasPending` 保守地保留每个 occurrence，Activation generation 会让过期观察失效，而最终 maintenance 任务则以原子方式衔接 idle ownership 与准入关闭。这项选择可能保留静默注入的 context，但既避免额外的 mutation 协议，也避免静默丢失已接受的 steering。

**用 `MessageSource.kind` 推导驻留，把 `plugin` 视为停放 context。** 拒绝，因为 `kind` 记录的是消息由谁产生，而非如何投递，且 `MessageSourceMap` 可合并扩展。插件会以 plugin 来源 steer（`cordis-host-runner` 的失败报告、阻断式 Stop hook），host 也会以非 plugin 来源 inject（`dsh-experimental-agent-team` 的静默邮件），因此该对应关系在两个方向上都不成立。统一对待所有待处理 occurrence 可以避免这种没有依据的推断。

## 结果

可继续子级会话与普通 Session 共享一套人类 inbox 交互模型和一套 Agent-loop queue。人类 steering 可以影响驻留或冷恢复的子级，而不改变公开模型控制。父级离线后，QueueDock 对在线子级仍有用；新消息则继续遵守直接父级鉴权。

通用 Session command 为拥有有效自身 suffix continuable identity 的在线 subagent-owned Agent 提供一个狭窄的 ownership-fence 例外。因为该操作可寻址两个 inbox 目标，知道待处理 `MessageId` 的调用方可以像操作普通 Session 一样，编辑或删除插件提供的 next-step 输入。QueueDock 只渲染 `queued` placement 的行，因此没有浏览器手势能到达该输入；在那里编辑还会保留原产出方的 `MessageSource`，从而把人类文本归属给该产出方。

Inbox notification 保留 occurrence 语义，不携带 continuation 驻留状态。Claim 与 discard notification 只负责在待处理工作变化后唤醒 settlement；`whenIdle()`、最终 idle 阶段 maintenance 任务、`Inbox.hasPending`、owned-child set、Activation generation 与 Session 序号无需依赖调度顺序、消息身份或来源即可决定何时安全 dispose。最终 flush 位于 closing cutoff 之前，因此 detached hook、job completion 或直接 Agent 投递只要在该 await 期间被接受，就会让观察失效，而不会被随后发生的 dispose 停止。仍然活跃的 maintenance 会阻止最终任务占用 idle 阶段；在 flush 期间开始并结束的 maintenance 已在 dispose 前完成。仅持有被注入 context 的 child 即使没有 driver 必须认领它，也会保持驻留；如果之后没有唤醒投递、queue removal 或 manager teardown，该 child 及其在线祖先可以在进程生命周期内一直驻留。重放出的 Inbox 遵循同一条保守规则，无需重建每条待处理消息的投递方式。

模型侧调度保持固定，不由调用方选择。相邻 Agent 的 `send_message` 工具始终使用 Steer，只有浏览器人类路径选择 Queue 或 Steer。
