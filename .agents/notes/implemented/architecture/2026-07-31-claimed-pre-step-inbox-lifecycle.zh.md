# Agent Note: 在单一 pre-step 决策前领取 inbox 输入

Status: implemented

[English](2026-07-31-claimed-pre-step-inbox-lifecycle.md) | 中文

## 问题

循环此前把一个步骤边界拆成提示词准备、提示词准入与串行步骤钩子。准入结果可以保留或丢弃已领取输入，实时队列事件还携带了与持久 inbox 状态重复的数据结构。插件不得不在修改 inbox、改写已提交批次与直接追加会话历史之间选择，而观察方无法依赖一套明确顺序。

单次出现专属的 inbox 包装层也重复了每个 `UserMessage` 已有的标识。它把插入、编辑、领取、取消、重连投影与步骤进入合并成一套协议，但仅追加会话本就拥有持久队列投影。

## 决策

每个拟议步骤之前，循环包内部的 `ReactLoopInbox` 会原子领取完整批次：全部 `next-step` 消息，以及轮次边界上的一条 `next-turn` 消息。在首次边界，循环会先提交 `turn/start`，使领取及其唯一一次 `agent/pre-step` 决策拥有持久轮次归属。领取会记录规范化、不带 outcome 的纯删除 `agent/inbox/spliced`，针对每条已领取消息发出一次 `agent/inbox/claimed { message, turn }`，并把独占批次返回给循环，由后者用 `{ turn, step, signal }` 等待 waterfall（瀑布式事件）。

`PreStepDecision` 为 `{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`。reject 不会打开步骤，会让已领取批次保持已删除，并将轮次关闭为 blocked，且不产生任何步骤事件。空的 enter、取消以及 `step/start` 前的失败同样会关闭一个边界平衡的无步骤轮次。enter 提供在 `step/start` 后以 `user/message` 追加的完整批次。包装 `next()` 的监听器会保留下游变更，除非有意替换，因此全部消息改写只在最终返回值中一次性结算。系统不再存在 `agent/prompt-prepare`、`agent/prompt-submit` 或 `agent/step` 扩展点。

持久 inbox 仍是两份通过 `MessageId` 寻址的 `UserMessage[]` 列表。`append`、`prepend` 与 `splice` 接受 target；`replace(messageId, newMessage)` 与 `remove(messageId)` 则在提交规范化 splice 前，通过 `MessageId` 跨两份列表定位待处理消息。替换可以改变标识，并先将旧消息作为 discarded 发布，再将新消息作为 inserted 发布。每次插入发出 `agent/inbox/inserted { message }`；普通删除记录 `outcome: 'canceled'` 并发出 `agent/inbox/discarded { message }`。领取记录不带 outcome 的纯删除，并由 `ReactLoopInbox` 发出 claimed 事件。这些实时事件不增加 placement、outcome 或批次字段。

`Agent.inbox` 只暴露用于读取和变更待处理工作的结构化 `Inbox` 接口；仅供循环使用的 `hasPending` 与领取操作不在该公开接口上。dsh-agent-loop 只构造一个 `ReactLoopInbox`，同时用于结构化命令与驱动器操作。具体构造函数直接接收 `SessionProjectionRegistry`，而不是更宽泛的 Cordis `Context`，并在首次读取前从 agent 作用域注册标准定义。`AgentLoop` 激活时要求该注册表服务存在，注册表则对多个 live agent 作用域贡献的定义进行引用计数。

两类事件接口服务不同消费方。跟踪单条消息的观察方使用 `agent/inbox/inserted`、`claimed` 与 `discarded`。每个 `ReactLoopInbox` 都从其 agent 作用域在持久 `agent/inbox/spliced` 流上贡献标准 `inbox` 投影；UI 编辑与移除通过 Inbox 变更方法处理，从而让同一投影记录所有变化。该投影重建持久历史时，会拒绝不安全或越界的坐标，以及跨两份列表重复的 `MessageId`，并报告出错事件的 seq。整体队列的 control 消费方使用投影变更流：Session controller 先发布 projection frame，再从同一份折叠后的 inbox 值派生 queue replacement。

必须对当前步骤进行原子改写的插件从 `agent/pre-step` 返回消息。只需要稍后上下文的插件可以直接修改 `agent.inbox`。Workspace context 同时使用两条路径：异步文件系统投影会暂存一条可替换的 `next-step` 消息，而下一次进入步骤的 pre-step 会把该消息或新组合的基线折入最终批次，并移除仍待处理的副本。reject 会让该条目继续排队。

已归档的[可寻址队列项决策](../../archived/feature/2026-07-29-addressable-queue-operations.md)描述了已被取代的单次出现包装层设计。`MessageId` 负责寻址，而 `ReactLoopInbox` 把 `inbox` 作为持久 splice 上的标准会话投影贡献给投影注册表。通用投影传输层会将该折叠结果用于实时更新、历史尾页的重连基线和冷进程重启恢复，无需 live Agent 镜像。

## 曾考虑的替代方案

**保留分离的 prepare 与 admit 钩子。** 这样准备阶段可以在领取前修改 inbox，准入阶段可以在领取后改写，但同一边界会出现两个顺序表面，取消归属也会变得模糊。

**reject 时把已领取批次重新入队。** 这看似保留重试行为，却会让否决隐式修改队列；若不为每个竞态加围栏，还会复制后续工作，并使 claim 无法成为原子所有权转移。

**在每个实时事件上携带 placement 与 outcome。** 持久 splice 已经拥有这些事实。实时通知重复它们会建立可能漂移的第二份约定，而持有确切消息标识的消费方并不需要这些字段。

## 验证

agent loop（智能体循环）覆盖固定先 `turn/start`、再领取、后 pre-step 的顺序、实时事件的确切载荷、边界平衡的无步骤 reject、最终批次改写、领取后插入的输入、监听器失败、取消，以及最后一个所有者卸载后移除 agent 作用域投影。Inbox 和消费方测试固定纯领取删除、普通删除的 canceled 结果、agent-instructions 的暂存、替换与同一步骤进入、plan/goal/钩子行为、UI 清理、压缩（compaction）、检查点、恢复后的持久投影、对非法持久坐标或跨列表重复标识的拒绝，以及 controller 早于投影注册表注册时仍使用折叠后队列值。只有当持久性不属于测试对象时，消费方领域测试才使用进程内 Inbox 桩；领取、持久投影、恢复、校验与实时通知测试通过生产 AgentLoop 测试 harness 创建 Agent，因此测试支持代码不会重新实现该投影。生成的事件与类型目录只公开新的 waterfall 与载荷。

## 后果

循环在每个步骤前只有一个需等待的决策，对输入也只有一次所有权转移。已领取消息不会隐式返回 inbox；后续插入保持独立。实时事件与其他 inbox 通知保持对称，但不镜像持久元数据；插件可以显式选择精确的当前步骤改写，或普通的后续 inbox 投递。
