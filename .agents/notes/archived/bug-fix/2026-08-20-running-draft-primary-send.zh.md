# Agent Note: 运行中草稿取得主 Send 操作

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-running-draft-primary-send.md) | 中文

## 问题

普通 Web composer 在 Turn 运行期间仍可编辑，键盘提交也能把草稿送入 Queue 或 Steer。然而，其唯一的主指针控件会在整个 Turn 中一直保持 Stop。指针用户输入后续消息并激活该控件时，会停止当前 Turn，而不是提交眼前的草稿；该控件因而与 composer 的可编辑状态和用户当前内容相冲突。

## 决策

`InputBar` 根据运行状态、草稿内容和 owner block 选择普通会话的主操作。运行中的 composer 为空时显示 Stop，并通过既有会话取消回调执行。存在非空白文字或至少一个附件时，同一控件切换为 Send，点击后使用既有 Queue 提交路径。owner block 会禁用编辑与提交，因此即使保留了草稿，运行中的 composer 也保持 Stop。清空草稿或成功提交后，只要 Turn 仍在运行，就会恢复 Stop。空闲会话仍显示 Send；草稿为空或无法提交时，该按钮保持禁用。

指针操作不继承 `ui-conversation.busyEnter` 偏好。该偏好仍然只为两个键盘手势选择 Queue 或 Steer。可继续 subagent 保留相互独立的 Send 与 Stop 控件，one-shot subagent 保持只读行为。

## 验证

`InputBar` 组件测试覆盖运行中草稿的空白、文字、清空、提交成功、仅附件和 owner-blocked 状态，并证明键盘偏好选择 Steer 时，按钮提交仍使用 Queue。无密钥的组装 Web 场景通过 replay 适配器停住真实组合出的 Turn，捕获显示 Send 的运行中草稿，经 Host Queue 路径点击提交，在草稿清空后观察 Stop 恢复，移除 Queue 行，再取消该 Turn。

## 备选方案

**在整个运行中 Turn 保持 Stop。** 这样可以始终立即取消，但可见的可编辑草稿没有指针提交操作，主控件也会执行与相邻内容相反的动作。

**为每个运行中会话同时渲染 Send 与 Stop。** 可继续 subagent 需要两个独立操作，因为其取消路由与继续投递不同。普通会话已有单一主操作位置；永久增加第二个控件会占用更多空间，并在草稿本身已经指明当前操作时引入另一套层级。

**让指针 Send 采用 busy-Enter 偏好。** 标记为 Send 的按钮会随键盘偏好在 Queue 与 Steer 之间静默变化。保持指针提交始终使用 Queue，可以保留既有显式区分，避免按钮携带不可见模式。

## 影响

指针用户无需等待当前 Turn 结束或使用键盘快捷键，即可提交后续消息。可操作草稿会占用唯一的主操作位置，因此 Stop 会在草稿清空或被接纳后恢复，而不是同时显示；owner block 会让该位置恢复 Stop，因为保留的草稿无法编辑或提交。键盘投递选择、取消传输和 subagent 控件均不变。Issue #2850 记录用户可见缺陷与验收边界。
