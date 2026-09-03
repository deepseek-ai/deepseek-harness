# Agent Note: Team 消息使用单一 Steer send_message 操作

Status: implemented

[English](2026-08-30-team-send-message-steer.md) | 中文

## 问题

Agent Teams 为一个持久 mailbox 公开了两个模型操作：quiet `send_message` 注入 live target 而不唤醒它，`followup_task` 则排入一个独立 waking turn 并冷恢复 inactive teammate。模型必须选择调度策略，而不是只说明消息目标；quiet 消息可能为 inactive teammate 持续累积，直到无关工作恢复它。

普通 continuable-Agent 控件已经使用一个方向无关、固定 Steer 调度的 `send_message`。保留独立的 Team 名称与投递模式，会让等价的模型通信因为 target 恰好是 direct child 还是 Team peer 而采用不同语义。

## 决策

每个 Team member 都会获得一个 `send_message({ target, message })` 工具。Team 工具集包含九个操作；不存在 `followup_task` 与模型可选的 quiet 投递。持久 `TeamMessageSnapshot` 存储 sender、target、content 与 message identity，不存储调度字段。

每条已接受的 Team 消息都使用 Steer。running target 在最近的步骤边界收到消息，idle target 启动一个轮次，inactive teammate 则通过 continuation lifecycle 冷恢复。每次成功的 Team send 都会在开始投递前完成持久化。`accepted` 表示 target inbox 已接受消息；`queued` 表示临时 inspection、resume 或 inbox 准入失败让消息留在 Team mailbox 等待恢复。两种结果都不表示 target 已完成所请求的工作。

Lead 通过 `Agent.steer()` 接收携带 Team 归因的用户消息。teammate 通过 symbol-keyed host-only continuation adapter 接收消息；该 adapter 会授权精确的 Lead-to-direct-child edge、保留原始 `TeamMessageSource`，并执行 resident 或 cold-resume Steer 准入。因此 sibling 与 teammate-to-Lead 消息保留真实 sender；Team 运行时绝不会伪装成 Lead 调用公开的相邻 Agent `sendMessage()`。

Lead Session 继续作为 mailbox transaction owner。它在 dispatch 前 flush `team/message/queued`，按 Lead 日志顺序为每个 target 串行化即时准入，并且只有 target Session 持久包含相同 Team message id 后才记录 `team/message/delivered`。恢复按顺序重试 queued-minus-delivered 记录；target 侧 source 折叠会防止 inbox insertion 与 acknowledgement 之间的 crash window 导致重复准入。

## 考虑过的替代方案

**保留 quiet `send_message` 与 waking `followup_task`。** 这会保留调用方对 turn 调度的控制，但要求模型选择实现策略、允许 inactive target 存在未读持久 mail，并与相邻 Agent 消息语义分叉。

**保留 `followup_task` 作为 Steer 别名。** 两个名字表达同一行为只会保留工具选择错误，不会增加可观察能力。

**通过公开的相邻 Agent `sendMessage()` 路由 sibling。** 该操作只授权精确的 direct-parent 或 direct-child 模型 sender，并派生自己的 `AgentMessageSource`。以 Lead 身份调用会错误归因 sibling mail；把它扩展到 Team membership 则会削弱相邻关系规则。

**删除 Team mailbox 并直接投递。** 直接投递会失去准入前持久入队、临时失败后的恢复、稳定 message id 与 target 侧去重。

## 测试

包测试固定 running、idle、inactive、Lead、sibling 与 recovery 投递，target-local ordering、sender attribution、inbox／history 去重、临时失败返回 `queued`，以及九工具 schema。无密钥 Agent Teams profile snapshot 驱动 running implementer，把 researcher 消息 Steer 到其下一步骤，并验证两个 teammate 都继续完成各自任务，之后 Lead 才汇总结果。

## 后果

模型只有一种 Team 通信选择，不能有意停放 quiet information。一条消息可能扩展 target 的当前 turn，因此提示词与测试要求 teammate 整合新消息，同时不放弃已经进行的工作。

host-only Steer adapter 成为 Team 投递使用的内部 continuation 集成。人类浏览器 prompt 保留独立 Queue adapter，并继续形成不同 turn。更广泛的 [Agent Teams 决策](../feature/2026-08-05-agent-teams.zh.md)继续负责 mailbox、roster、task 与共享 checkout；[相邻 Agent 消息决策](../architecture/2026-08-27-adjacent-agent-steer-messaging.zh.md)继续负责公开 direct-edge authorization 与 model-message source。
