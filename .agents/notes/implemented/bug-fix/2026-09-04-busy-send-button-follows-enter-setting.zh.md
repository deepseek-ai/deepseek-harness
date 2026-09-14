# Agent Note: 繁忙态 Send 按钮跟随 Enter 设置

Status: implemented

[English](2026-09-04-busy-send-button-follows-enter-setting.md) | 中文

## 问题

Web composer 为 agent（智能体）运行期间的提交只提供一个面向用户的选择：`ui-conversation.busyEnter` 设置在 Queue 与 Steer 之间选择。[运行中草稿取得主 Send 操作](../../archived/bug-fix/2026-08-20-running-draft-primary-send.md)（已归档）为运行中的草稿提供了指针 Send 按钮，有意让它不跟随该偏好，以避免一个只标注为 Send 的按钮携带不可见模式，并把每次点击都路由到公共的 `InputActions.submit()` 接口，而 `SessionInputShell.actions` 把该接口固定为 `'queue'`。用户在设置中选择 Steer 后，Enter 得到 Steer，同一草稿旁的按钮却得到 Queue，且按钮只标注为"发送消息"。composer 中没有任何内容解释这一分歧，设置行的标题和描述也只提到 Enter 键，因此该设置看起来像是失效，而不是有意只覆盖一部分。

## 决策

运行中的 Send 按钮按与 plain Enter 相同的模式投递。`InputBar` 每次渲染计算一次 `resolveSubmitMode(busyEnter, running, 'enter', steeringAvailable)`，其中 `steeringAvailable` 与键盘路径使用同一个"普通 Session 或可继续 child"判定；用它通过 `ComposerKeyboard.submit(mode)` 执行主按钮点击，并且仅在点击会投递一条普通消息时用它决定主按钮标签：composer 运行中且可 steering、按钮可用（没有仍在上传的文件）、草稿非空、未被认领且不是将进入命令 adjudication 的 `/` 行。该状态把 `input.send.queue`（"Queue message" / "排队发送"）或 `input.send.steer`（"Steer message" / "插话发送"）同时用作 tooltip 与可访问名称；该位置仍为 Send 按钮的其余所有状态——空闲会话、one-shot child、锁定的 composer、可继续 child 的空草稿、带待上传附件的草稿，以及点击会执行命令而非投递消息的命令草稿——保留 `input.send`（"Send message"）；普通运行中会话在空草稿或 owner block 时该位置显示的是 Stop。Cmd/Ctrl+Enter 仍解析为相反模式，空草稿下的加速手势仍对整个队列执行 steering（中途引导）。[可继续 subagent 中断 Agent Note](../feature/2026-08-06-continuable-subagent-interrupt.zh.md)以此投递方式描述 child 的 Send。

composer bar 的 inject 接口携带实时偏好，而不是解析闭包。`ComposerBarInjected.hooks.busyEnter` 发布 `ComposerSubmissionPolicy.busyEnter`，因此 bar 获得 `useBusyEnter` 选择器 hook，并在设置行或 Host 设置更新改变该值时重新渲染标签。`resolveSubmitMode` 是 `submission-policy.ts` 中导出的纯函数，显式接收偏好值；policy 类只保留 store 及其 Host 采纳与写回。

设置行重新命名以覆盖两种输入："Send behavior while busy" / "繁忙时的发送行为"，描述为 agent 运行时 Enter 与 Send 按钮的行为，并保留 Cmd/Ctrl+Enter 使用相反模式的说明。`busyEnter` 字段名、其 `queue` 默认值和 Host schema 均未改变，因此现有 `settings.yaml` 文档保持原有含义。

## 验证

`input-bar.client.spec.tsx` 断言运行中草稿的按钮在两种偏好下都按模式标注并以该模式提交，切换偏好 store 会在下一次点击前重新标注已挂载的按钮，空闲 Send 无论偏好如何都保留普通标签与 Queue 投递，可继续 subagent 的 Send 与普通 Session 遵循同一模式与标签，而其空草稿下的禁用按钮与 one-shot child 保留普通 Send，运行中的 `/` 行、已认领命令与带仍在上传文件的草稿也保留普通 Send。`submission-policy.client.spec.ts` 钉住 `resolveSubmitMode` 在偏好、运行状态、手势与 steering 可用性所有组合下的结果。`enter-behavior-row.client.spec.tsx` 与 `settings-chrome` ARIA golden 携带新的设置文案。无密钥的 `live-interactions` Web 场景在停住的运行中草稿上等待"Queue message"，并断言此刻不存在"Send message"按钮，其 `running-draft.expected.md` golden 记录了新名称。

## 备选方案

**保持按钮使用 Queue，只改写设置行文案。** 这保留了先前决策，但让同一设置下的同一草稿拥有两条提交路径。偏好 Steer 的用户仍无法通过指针得到它，而改写后的设置行必须记录一种其他 composer 控件都不具备的仅键盘生效范围。

**增加第二个运行中按钮，每种模式一个。** 两种投递模式都可以通过指针到达且没有隐藏状态，但普通会话只有一个主操作位置，且已在 Stop 与 Send 之间交替；永久增加第二个控件会占用空间，并引入草稿本身不需要的层级。单一设置已经表达了用户默认值，Cmd/Ctrl+Enter 仍是逐条消息的覆盖手段。

**通过 `InputActions.submit(mode)` 传递模式。** 拓宽公共 provide 通道接口会让任何 session 作用域的 slot 都能选择投递模式，而没有其他消费者需要它，并且会把 composer 的呈现决策推入机器的公共契约。包内私有的 `ComposerKeyboard.submit(mode)` 正是为此存在，因此按钮直接使用它。

**在 inject 接口上保留 `resolveSubmitMode` 闭包，仅为标签另加一个 `busyEnter` hook。** 同一事实有两个来源，会让标签所说与点击所做之间产生偏差。只发布一次偏好并在 bar 中解析，可以让标签与投递在同一次渲染中源自同一个值。

## 影响

该设置约束用户能以消息触发的每一种繁忙态提交，且按钮会声明它执行哪种投递，因此选择 Steer 后不再会从草稿旁的按钮产生 Queue 行。此前在设置为 Steer 时依赖按钮作为始终 Queue 逃生口的用户，现在改用 Cmd/Ctrl+Enter。运行中的 Send 标签对每位用户都会变化，包括默认的 Queue 偏好下，运行中点击 Send 的 Web e2e 场景已相应处理；空闲会话流程和 one-shot subagent composer 没有变化。已归档的运行中草稿 Agent Note 中"指针操作忽略偏好"的条款在此被反转；其主操作位置、owner block 与 subagent 控件决策按已交付状态继续有效，并由 `ui-conversation` README 描述。
