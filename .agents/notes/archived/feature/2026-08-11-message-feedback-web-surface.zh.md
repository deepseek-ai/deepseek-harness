# Agent Note: 消息反馈的 Web 界面

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-message-feedback-web-surface.md) | 中文

## 问题

[PR #2217](https://github.com/deepseek-harness/deepseek-harness/pull/2217) 交付了持久化的消息反馈 sidecar 及其三个 Host Remote 方法，但它明确只做后端：没有任何客户端包消费 `messageFeedback.list`、`put` 或 `delete`，因此 Web GUI 无法记录评价。它的 Agent Note 把「客户端 Remote aggregate 挂载与 UI」留给了另一个负责人。Issue #1326 要求的正是 Web 界面，却在该后端合并时被关闭，而用户可见的那一半并不存在。

更早的全栈尝试 [PR #1010](https://github.com/deepseek-harness/deepseek-harness/pull/1010) 带有 UI 层，但它基于自己的后端、形状不同：整个 Session 一个 `revision` 做 compare-and-swap，RPC 名为 `feedback.upsert`。#2217 最终交付的是逐条 `ifVersion` 与 `messageFeedback.put`，因此 #1010 的 controller 逻辑不再匹配契约；它的分支在结构上也已漂移（改动了 `packages/cordis/`，该目录已重命名为 `packages/extensions/`；新增的顶层 `packages/session-feedback/` 与整合后的 `packages/feedback/` 冲突）。它作为 superseded 关闭，而不是 rebase。

任何 UI 的阻塞缺口在于浏览器无法指名一个反馈目标。Host 只接受以 `MessageId` 寻址的 append 来源 `assistant/message`，但 `AssistantMessageNode`——客户端表示已完成 assistant 输出的节点——只携带 `seq`、`turn`、`step`，没有消息身份。只有 `SteeringMessageNode` 有 `messageId`。

## 决策

三个接缝，各自归属于其权威已经所在的位置。

**客户端节点中的消息身份。** `AssistantMessageNode` 增加可选的 `messageId`，在该节点由已完成的 `assistant/message` 物化时从 `event.data.message.id` 复制。它在被中断冻结的部分输出上保持缺失——那些从未完成、不指向任何持久消息——在 trajectory 布局为未完成部分输出构造的合成哨兵上同样缺失。该字段之所以可选，正是为了让这两种情况无法被表示为反馈目标，而不是用占位值掩盖过去。`ui-conversation` 与 `ui-trajectory` 各自物化自己的该节点副本，因此两条「已完成」分支都做了更新；「被中断」分支被有意保留原样。这与 Host 自身的目标规则一致——它按 `isAppendSurfaceEvent` 过滤——因此客户端与 Host 在「什么是可寻址的」上取得一致，而不需要共享代码。

**声明式槽位而非直接依赖。** `ui-conversation` 声明 `conversation.chat.assistant-actions`（list 类型、session 作用域、owner 为 `{messageId}`），并把它授权为 `turn-tail` 节点渲染器的第二个子项，与既有的 `conversation.chat.turnTail` 链并列。`TurnTailNodeView` 渲染它，并通过新的 `extraActions` prop 把结果传入 `MessageIconActions`，位置在复制与分支之间。当 `messageId` 缺失时渲染点整体跳过该槽位，因此被中断的 Turn 不显示任何控件。反馈包因此只贡献一个 entry，从不引入 conversation 的实现；当该插件从 `cordis.yml` 组装中移除时，这条操作栏以零成本渲染为空。

`extraActions` 是一个 `ReactNode` prop 而不是第二个 render-slot 洞，因为 `MessageIconActions` 是用户消息与 assistant 消息共享的外壳：由 assistant 一侧解析槽位并把结果向下传递，用户路径则对这个它永远不该渲染的槽位保持无感。

**per-session controller 中的逐条 CAS。** `@deepseek-ai/dsh-client-ui-message-feedback` 为每个 Session 持有一个 `MessageFeedbackController`，以 `MessageId` 为键存入 map。一次 `list` 为该 Session 转录中的所有控件播种。每次 mutation 发送该 controller 最后观察到的版本作为 `ifVersion`——当它不知道任何条目时为 `null`，这正是 Host 的「必须不存在」前置条件。

冲突路径是与 #1010 分歧最大的地方。`MessageFeedbackVersionConflict` 携带权威的 `current` 条目（或 `null`），因此竞争失败方直接从回复本身收敛；#1010 对每次冲突都以一次盲目的全量刷新作答。报告 `current: null` 的冲突会删除本地条目，这就是在另一个标签页中被移除的评价在此处消失的方式。mutation 在 per-Session 的尾部串行化，因此排队中的操作总是与已提交的版本比较，而不是与点击落下那一刻读到的版本比较。

list 读取被推迟到首次 hover 或 focus，而不是在 mount 时触发，因为控件会为可见历史中每条已结算消息各 mount 一次；在 mount 时做全转录读取会导致每条消息栏各发一个请求。`connection/reset` 只刷新状态不再是 `cold` 的 Session，因此重连不会预热没人看过的 Session。

切换语义让两个动词保持诚实：再次点击已记录的评价调用 `delete`，切换到另一侧调用 `put` 并携带已有备注，而对没有已知条目的消息执行清除会直接返回成功且不发起调用，因为它已处于被请求的状态。

**Remote 挂载。** `@deepseek-ai/dsh-api-remotes` 现在把 `messageFeedbackRemote` 与 `goalsRemote` 并列挂载，并以相反顺序组合两个 disposer。生成的 `./remote` 产物在 #2217 的包导出中已存在，因此不需要 codegen 改动；客户端调用 `ctx.remote.messageFeedback`，从不接触传输层。业务结果以普通的 tagged union 穿过该边界——gateway 只在传输失败时抛出——因此 controller 对 `ok` 做模式匹配，并把抛出翻译为控件已经在渲染的同一种结算结果形状。

## 考虑过的替代方案

**复用 `conversation.chat.turnTail` 而不新增槽位。** 否决：`turnTail` 是以 Turn 为键的链，携带 `TurnTailOwnerProps {turn, seq, openFile}`，寻址的是 Turn 边界而非消息身份。反馈需要 `MessageId`，而链是选择器路由的一次一个，操作栏则确实是一组互相独立的贡献者的列表。

**把 `messageId` 放到 chat 节点的 `id` 字段上。** 否决：该 id 是 `"${turn}:${step}"`，且承载着 keyed dispatch 与稳定 React key 的作用。重载它会把节点身份与模型输出身份耦合起来，而且一旦存在 replacement 来源的事件，消息 id 本身在每个节点上也并非唯一。

**保留 #1010 的 session 级 revision。** 不可行：已合并的 Host 契约是逐条 `ifVersion`。即便作为客户端侧的简化也更糟——单一 Session revision 会让互不相关的逐条编辑相互冲突，而这正是 #2217 的 Agent Note 记录的采用逐条版本的原因。

**Rebase #1010。** 经检查后否决：102 个文件、`mergeable: false`、一个被 #2217 以不同名称取代的重复后端与 RPC 层，以及此后的两次目录重命名。只有其约 1400 行的 UI 层有残余价值，而该层调用的 `feedback.upsert` 及其 revision 已不复存在。基于已合并的契约重写 UI 比调和该分支更省力，#1010 的关闭评论记录了这一理由。

## 结果

Web GUI 可以记录逐条消息的评价与备注。#1326 中用户可见的那一半现在存在了；该 Issue 之所以被重开，是因为后端合并在没有任何入口存在的情况下关闭了它。

`AssistantMessageNode.messageId` 是可选的，因此所有既有读取方无需改动即可编译，但任何将来的消费方都必须处理缺失，而不能假定消息已完成。两个并行的物化点仍是重复隐患：第三个构造该节点的视图必须记得复制该 id，而没有任何机制强制这一点。只有 chat 视图渲染控件，尽管 trajectory 与 waterfall 节点现在携带同一个 id。

反馈对模型保持不可见——该 sidecar 既不进入 Session 日志、也不进入模型上下文与 telemetry——因此该包的 Model Experience 是一条经审计的 `none` 条目，而不是结构化区块。

该 sidecar 不发布实时帧，因此第二个标签页的评价会在重连时或下一次冲突回复时才浮现，而不是立即。备注编辑器不预先校验 `maxNoteBytes`（Web bundle 中为 8192），因此过大的备注会在保存时以 `note-too-large` 失败，而不是在输入过程中。

24 个既有 Web UI 快照在 27 条 assistant 消息上获得了这两个评价按钮，确认这条操作栏在已发布的组装中触达每条已结算的 assistant 消息，而不仅是被测试的那个 fixture。

一个专门的 Web E2E 针对已发布 bundle 覆盖评分、备注、重载恢复与撤回。它必须在重载后先 hover 未评分的控件，再断言恢复后的状态，因为正是那次延迟的 list 读取让 sidecar 的值出现——该测试记录了这一顺序，而不是绕开它。把 controller 的 list 恢复逻辑破坏掉会让该规格失败，因此这条持久性断言是有效的。
