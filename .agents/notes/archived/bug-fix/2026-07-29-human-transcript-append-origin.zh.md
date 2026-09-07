# Agent Note: 人类可读记录投影追加来源的事件

Status: implemented
Archived: 2026-09-04

[English](2026-07-29-human-transcript-append-origin.md) | 中文

## 问题

终端与宿主历史网关都把模型可见的 surface 当作 transcript（文本记录）。一次成功的压缩（compaction）会用一个检查点节点替换一段 surface 范围，因此该替换一落地，终端就丢弃了它所遮蔽的每条消息——那些是用户已经读过的对话——并在此后任何替换到来时重新执行这次破坏性重建。同样的混淆也波及分页：`maxMessages` 统计窗口内的每个 `user/message` 和 `assistant/message`，于是仅供模型使用的替换副本占用了一个人类从未填充的页面额度，而切分点还可能落在压缩的仅日志 `compaction/summary` 事件与引用它的替换之间。

日志本身没有丢失任何内容。`Session.snapshotEvents()` 仍返回每条原始消息和完整的工具结果；surface 只决定接下来发送给模型的内容。缺陷完全在投影层。

## 决策

模型投影与人类投影是分开的，而事件属于哪一种由事件自身的标记决定。`dsh-session` 在浏览器安全的 `surface` 模块中导出按两种 `SurfaceOp` 变体划分的谓词 `isAppendSurfaceEvent(event)` 与 `isReplacementSurfaceEvent(event)`。追加来源的事件是 transcript 的持久来源，替换副本仅供模型使用。凡是必须准确发送模型所见内容的部分——`deriveMessages`、token 记账、压缩后端、工具配对、注入上下文的存活判断、跨会话引用投影——都继续读取 `session.surface`。

终端从追加来源的 surface 事件回放 transcript，并通过 `transcriptToolCallIds` 让被遮蔽步骤的工具卡片保持配对：该函数读取追加来源的 `assistant/message`，而不是 surface 成员关系。已落地的压缩会在其自身日志位置贡献一行暗色 `… earlier context was compacted …`：这行标记报告模型从何处起不再看到那段历史，而不是把它抹掉。带框的检查点载荷从不渲染，且两条路径都按同一个标记对 surface 事件分类，因此实时到达的压缩与恢复后回放同一份日志会产生相同的 transcript。只有回放会重新推导 `tool/call` 的配对关系：调用事件自身不携带标记，其归属继承自公布它的 `assistant/message`，而实时监听器必然刚刚渲染过后者。

检查点通过压缩 seam 自身的约定来识别——`isCompactCheckpointSource`，即 `CompactionEngine` 要求替换用户消息携带的、与后端无关的标记——因此终端依赖的是已声明的词汇，而不是替换的形态。`dsh-session-reference` 已经在用该谓词投影另一个会话的日志；这里只是另一个读者提出同样的问题。其他替换保持静默：被裁剪的 `tool/result` 与重新生成的 `assistant/message` 只是为模型重写一个节点，并不在对话中标出边界。

`session.history` 只把追加来源的消息计入 `maxMessages`。每一页仍是一段连续的原始事件区间，因此压缩的 `compaction/summary` 事件会与引用它的替换留在同一页。

持久事件、RPC 信封、压缩事务与模型可见的 surface 都没有变化，也不需要迁移。

## 延后事项

浏览器客户端在[Web transcript 投影笔记](2026-07-30-web-transcript-log-ordered-projection.zh.md)中单独修复：它按日志顺序投影同一份追加来源 transcript 并渲染一个标记组件，同时闭合本次变更打开的分页缺口——因为 `session.history` 不再为检查点消耗额度，它永远不会在检查点与检查点引用的来源事件这个整体内切分，于是一页可以携带一个引用了窗口之外 `surfaceOp.start` 的检查点，而浏览器的 surface fold 会拒绝该范围。这个缺口早于本次变更（此前计数就可能越过检查点进入它所遮蔽的范围），但当检查点是最旧的被计数消息时，旧分页规则会把整段被遮蔽的范围放在同一页。

终端的[已归档实时压缩进度决策](../../archived/feature/2026-07-30-compaction-progress-visibility.md)使用独立标记对中的事件驱动现有的单格指示器。它既不改变本文所负责的完成标记，也不添加规模信息：检查点的 `sourceEventSeqs` 仍可供经另行论证的计数或区间使用。因此，进度显示既不需要修改标记内容，也不以提取 `renderReplacement(event)` 为前置条件。

## 曾考虑的替代方案

**按形态识别检查点（一个替换型 `user/message`）。** 被否决：那读取的是已交付生产者集合的巧合而非已声明的约定，而未来任何用用户消息替换一段范围的生产者都会静默地继承压缩标记。seam 已经发布 `COMPACT_CHECKPOINT_SOURCE`，正是为了让消费方与后端无关地识别检查点。

**继续把检查点渲染为注入上下文卡片。** 被否决：带框的检查点是为模型撰写的指令信封，不是人类对话内容。展示它却隐藏它替换掉的历史，正好颠倒了读者的需要。

**持久化第二份展示用 transcript。** 被否决：仅追加的日志已经包含权威源材料，平行 transcript 换不来任何东西，反而增加迁移与一致性工作。

**用 `compaction/*` 括号而不是检查点来推导标记。** 就 transcript 而言被否决：括号是围绕一次操作的一对时间点标记，而 transcript 需要的是 surface 真正发生变化的位置。括号适合作为进度与耗时的来源，而本次变更并不渲染这些。

**像 `session-query` 为搜索所做的那样重新折叠日志来分类事件（`current`／`shadowed`／`log-only`）。** 被否决：折叠回答的是整份日志的问题，而投影问的是逐事件的问题，事件自身的标记已能以常数时间给出答案。

## 后果

压缩不再抹掉终端历史；被压缩多次的会话会按日志顺序显示每次落地压缩对应的一行标记。分页的每一页可以携带比以前更多的原始事件，因为额度只花在人类或模型真正产生的消息上。

`rebuildTranscript` 现在会为整份日志中的每个追加来源事件物化一个组件，并在挂载时、终端配色方案变化时以及每次切换推理（reasoning）时运行。压缩此前正好为压缩所服务的那些长会话限制了这项工作量，因此这份开销现在随会话长度增长，而不再随 surface 增长。这正是本次修复要做的取舍——保留历史才是目的——但窗口化或复用策略属于第一个真正测到重建变慢的人，而不属于日后某个疑惑工作量为何增长的性能分析者。

`dsh-tui` 为一个纯谓词新增了对 `dsh-compaction` seam 的依赖，与 `dsh-session-reference` 现有用法一致。终端在运行时仍然不需要任何压缩后端。

两项行为随其测试一起改变。表层替换的终端测试此前钉住的是抹除（「隐藏被遮蔽的工具调用」），现在钉住的是保留加恰好一行标记，其中被裁剪的结果副本、重新生成的 assistant 消息以及来自其他插件的替换都不渲染任何内容。压缩快照场景此前声称钉住压缩，却写入了 `agent-instructions` 来源；现在它写入真实的检查点来源，并重新录制三份 fixture（测试前置数据），以显示被保留的提示、完整的工具卡片和那行标记。

上文的实时／回放等价性由 fixture 钉住，而不只是在此断言：`surface-replayed-compaction` 在挂载时替换已经存在，其录制结果与实时路径的 `surface-after-compaction-wide` 逐字节一致。改动任一路径都会破坏这项相等——这正是要点：回放投影才是当初对用户造成回归的部分，两份 fixture 必须一起变动。
