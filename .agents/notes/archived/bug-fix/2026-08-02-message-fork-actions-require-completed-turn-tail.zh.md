# Agent Note: 消息 fork 操作要求消息位于已完成轮次尾部

Status: implemented
Archived: 2026-09-04

[English](2026-08-02-message-fork-actions-require-completed-turn-tail.md) | 中文

## 问题

Web 会话把分支操作挂到每个轮次中最后一个文本非空的 assistant 节点上。如果后面还有工具结果、被中断的推理（reasoning）节点或终态错误，这些行也不会接管操作，因为它们没有内容文本 IconActions。因此，分支图标可能出现在 assistant 响应下方，而同一轮次的更多行仍位于其后。Host 会正确地把该消息锚点扩展到其所在的 `turn/end`，但图标位置使操作看起来像在消息级截断，子会话又会明显继承同轮次的后缀。

## 决策

`ConversationSnapshot.turnEnds` 保留原始事件窗口中的已完成轮次边界。会话视图按各边界遍历 transcript（文本记录）节点，仅当边界的最后一个节点是用户消息、持久 steering（中途引导）消息或含内容的 assistant 消息时才启用分支操作。开放轮次没有符合条件的消息；如果后面还有工具结果、只有推理内容的中断、轮次错误或其他 transcript 节点，较早消息上的分支操作会保持不可用。不可用的控件仍然可见、可聚焦、可悬停；`aria-disabled`、tooltip 与 `aria-describedby` 会说明已完成尾部这一要求，且不会发送 Host 请求。复制和时钟仍可在既有消息 chrome 下使用，Host 按已完成轮次 fork 的语义保持不变。

本资格判定中消息气泡的那一半已被 [user 气泡分支移除决策](../simplification/2026-08-06-user-bubbles-drop-the-branch-action.zh.md)取代：user 与 steering 气泡不再渲染该控件，因此只有含内容的 assistant 尾部可以 fork；assistant 侧门禁及其可见但不可用的呈现保持有效。

本决策收紧了较早的 [Web 会话 fork 操作决策](../feature/2026-07-27-web-session-fork-actions.zh.md)所定义的消息资格。Session 行 fork 仍选择最新的已完成轮次；符合条件的消息操作仍通过共享 client 运行时操作传递其事件 seq。

## 考虑过的替代方案

**在点击的 assistant 消息处截断事件日志。** 不予采纳：assistant 消息可能位于尚未结束的步骤内，也可能包含结果随后才出现的工具调用。以该 seq 截取的原始前缀并不是结构完整的轮次，也可能不是有效的提供方 transcript。

**从 `running` 或下一条用户消息推断完成状态。** 不予采纳：重试轮次与 steering 轮次不一定和下一个可见用户气泡对齐，分页窗口也可能省略该气泡。持久 `turn/end` 事件才是权威的完成事实。

**对每个被中断轮次隐藏分支。** 不予采纳：已中止的轮次会持久关闭，其最终的中断文本可能正是真正的 transcript 尾部。资格取决于已完成边界与节点顺序，而非结果类别。

**隐藏不符合条件的消息控件。** 不予采纳：消失的控件无法说明边界要求，还会让本应稳定的消息 chrome 发生位移。保留可聚焦但不可用的控件，既能维持操作提示，也能阻止请求。

## 后果

启用的分支图标现在表示的已完成轮次边界与 Host 实际复制的边界一致。在所报告的「响应 → 工具 → 被中断的 Think」形态中，响应仍保留复制、时钟，以及一个说明无法操作原因的禁用分支控件。本变更刻意不提供同轮次 transcript 编辑，也不提供轮次前重试操作；当读者希望完整复制最新的已完成轮次时，仍可使用 Session 行操作。运行时测试固定边界投影和引用稳定性，会话测试则覆盖 assistant 尾部、纯用户消息尾部、持久 steering 尾部，以及后续工具行和被中断推理行导致的不可用控件。
