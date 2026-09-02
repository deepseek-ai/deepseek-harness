# Agent Note: Trajectory 基于注册式 Conversation Context 组装数据

Status: implemented

[English](2026-08-11-trajectory-conversation-context-assembly.md) | 中文

## 问题

Trajectory 曾维护独立的 Session History 数据源，并把完整的已加载 Event 窗口折叠为 Assistant、Tool、消息、Request header 和 Compaction 状态。Chat 已经通过注册式 Conversation Definition 组装相同的 Event 族。两条链路重复实现业务关联与分页行为；即使只改变一个业务对象，Trajectory 的结构更新仍会复制或重新扫描与原始 Event 数量成正比的数据。

复用 Chat 的最终 Node 无法解决职责问题。Trajectory 需要请求生命周期、运行中 Assistant 状态、提示词继承、Tool schema、计时记录和 stage-oriented read model，而 Chat 不消费这些数据。共享最终 Node payload 会让两个视图都依赖双方需求的并集。

本次迁移还必须保留持久 steering（中途引导）分类。`user/message` 本身不说明它是开启了一个 Turn，还是从 `next-step` inbox 被领取；更早页面还可能在消息已经物化后，才补齐缺失的 inbox 前驱或 Location。

## 决策

Trajectory 针对共享的 [`ConversationNodeAssembler`](2026-08-09-client-conversation-node-assembly.zh.md) 注册 target 自有的 Conversation Definition 和 `trajectory` View Builder。Session 只维护一份连续 Event 窗口，并通过 `Session.views` 发布 Chat 与 Trajectory 快照；它不再运行第二套 Trajectory history source 或业务 fold。

每个 Definition 只属于一个 target。Chat 与 Trajectory 可以识别同一持久 Event 族，但分别维护自己的 State 和最终 Node payload。它们只共享 Assembler 的精确 ID 匹配、有序 Match、Location 事实、Reader 依赖、发布调度，以及 replace/prepend/append 生命周期。

Trajectory 的 target source 在首次订阅时激活 View Builder。在此次订阅之前，其 Definition 会维护最新 State，而 Assembler 跳过 `buildViewNode()` 和 snapshot assembly。取消订阅后 target 仍保持 active，因此后续访问会复用持续增量维护的 snapshot。

既有的 [Trajectory 检查记录表](../feature/2026-07-27-trajectory-inspection-ledger.zh.md)继续作为视图模型。Trajectory Builder 把已物化的 target Node 转换为原有的 `eventNodes`、Requests、Tool schema、运行中调用和 Location map；layout、表格虚拟化、选择、Overview 与检查器行为不会成为通用 Conversation 约定。

### 业务 Definition

| 业务 | Context 标识 | State 组装方式 | Trajectory contribution |
|---|---|---|---|
| `next-step` inbox | splice Event seq | 把 splice 应用到最近的前序 inbox Context | 只维护状态，不产生可见 Node |
| 用户、steering 或注入消息 | message Event seq | 读取前序 inbox State，并对持久消息分类 | Input 或 context Node |
| Assistant 与普通 Request | `turn:step` | 折叠 `step/start`、chunk、最终消息、retry 和 `step/end` | 最终 Assistant、partial Assistant 与 Request |
| 根 Tool call | root call ID | 把根 call/result 与嵌套 Code Dispatch Event 折叠为一棵调用树 | 最终或运行中的 Tool tree |
| Compaction | compaction ID | 折叠 start、summary、end 和 replacement checkpoint | Compaction Request |
| Request header | header Event seq | 读取前一个 header，保留生效提示词及真实变化 | Prompt 与 Tool-schema 来源 |
| Session 与 Turn 边界 | boundary Event seq | 保留关闭时间和错误事实 | 被中断的 Compaction 或失败的普通 Request |

每个关联 Event 都必须直接提供相同的业务 ID。Code Dispatch 使用 `rootCallId`，Compaction 使用 compaction ID；即使某个 Definition 按 `turn:step` 关联，普通 Tool 与 retry Event 仍保留各自的协议标识。缺少必要关联 ID 的旧记录由该 Definition 忽略，不会合入 `undefined` Context，也不会导致 Session 崩溃。

Assistant chunk 只更新对应的 `turn:step` Context。带内容的 chunk 请求 animation-frame 发布；usage 与 finish chunk 更新 State，但不单独强制刷新一帧。最终消息、retry 或边界立即发布。已完成 Assistant State 只保留组装后的 block、计时、usage 与 retry 事实，不会把原始 chunk ledger 复制进 target snapshot。

### 通过前序 Context 恢复 steering

Trajectory 从持久 inbox 历史恢复 steering，使用与 [Chat steering 决策](../feature/2026-08-04-web-context-source-and-steer-marks.zh.md)相同的标识规则，但不共享 Chat 的最终 Node。

每条目标为 `next-step` 的 `agent/inbox/spliced` Event 都会启动一个以 Event seq 标识的不可见 Context。它的 `start()` 读取最近的前序 inbox Context，把 splice 追加到持久的 pending ID state，并只在 claim 时 materialize 该 state、替换当前 claimed batch。AgentLoop 会在领取下一批消息之前追加当前 claim 接纳的全部消息；被拒绝的 claim 不追加 `user/message`。后续用户来源的 `user/message` 读取最近的前序 inbox Context：ID 属于当前 claim 时生成 Steering Node，其余用户来源消息生成普通 User Node。

仍有更早历史时，Reader miss 会记录 window-gap 依赖。prepend 补齐缺失的前驱后，Assembler 按 Event 正序重放受影响的 inbox chain 与 message Context。因此，历史分页方向不会永久错误分类消息。

消息 Event 的 Location 会把 steering 放进所属 Step。如果已加载历史窗口缺少足够的边界 Event，无法解析该 Location，layout 就以后续 Assistant step 作为位置回退。同一个 Step 中，运行中 Request 标记排在前置 steering 输入之后，因此该标记表示由这条输入触发的模型 Request，而不会出现在输入前面。

### 窗口链路与复杂度

记 `E` 为已加载原始 Event 数，`P` 为一次新 prepend 的页面，`D` 为 Trajectory Definition 数，`C` 为已物化的 Trajectory Context contribution 数，`Mᵣ` 为一次 prepend 使其失效的 Context 所持有的 Match 总数。`D` 是较小的注册集合；流式 chunk 会聚合到同一个 Assistant Context，因此通常 `C` 明显小于 `E`。

| 链路 | Context 工作量 | Target snapshot 工作量 | 结果 |
|---|---|---|---|
| 初始尾页或重连 replace | 以 `O(E × D)` 匹配已加载窗口，并按 Event 正序构造 State | inactive：无；active：构造并排序 `C` 个 contribution | 完整 Context replace 仍与已加载窗口成正比 |
| 更早页面 prepend | 只匹配新 Event，并只重放 Match、Location 或 Reader 答案发生变化的 Context，成本为 `O(P × D + Mᵣ)` | inactive：无；active：从 `C` 个 contribution 重建 stage snapshot | 业务 fold 不会从头重跑全部 `E` 个 Event |
| 实时 append | 以 `O(D)` 匹配，以 `O(1)` 找到 keyed Context，并只更新对应 State | inactive：无；active：在 snapshot 组装前以 `O(1)` 替换 anchor 未变的 contribution | 业务关联成本与已加载 Event 历史无关 |

首次激活会从当前 `C` 个 target Context 构建 Node，而不会重新匹配 Event，并调用一次 `replace()`。激活后，Builder 按 Context key 保存 contribution，并维护 key-to-position index。anchor 相同的内容更新会原位替换一个 contribution；新增 contribution 或 anchor 变化才会重建并排序 contribution 顺序。随后，snapshot assembly 遍历 `C` 个 contribution，用 Map 索引 Request header 与 Tool schema，并以线性游标或索引处理 Compaction boundary 与 Turn error。

最终 Event 和 Request 排序使单次发布的当前上界保持为 `O(C log C)`。本次迁移移除了重复反向查找和旧的原始历史 refold，但不声称端到端发布达到 `O(1)`。Chat 保持既有 keyed snapshot 行为与复杂度；增加 Trajectory target 不会让 Chat 扫描 Trajectory Context 或 Node。

### 独立的表现层热点优化

Context 迁移与下列表现层优化解决的是不同成本。这些优化保留既有视图模型；收益来自调用次数和渐进复杂度推算，本决策不声称存在 benchmark 实测结果。

| 热点 | 保留的行为 | 预期减少的工作 |
|---|---|---|
| Markdown 摘要 | Layout 只保留源 Markdown；每个稳定 Table record 按内容 memo 展示摘要，Detail 只解析当前选中记录 | 单条 record append 只重解析发生变化的可见记录，而非全部 Markdown record |
| 搜索文本 | `TrajectorySearchIndex` 仍线性核对稳定 Record ID 与来源签名，但只为变化的 record 标准化 Markdown，并以三秒批次提交更新 | 签名比较仍为 `O(C)`；昂贵标准化只随变化 record 数量增长，持续 frame update 每个时间窗合并成一个批次 |
| Timeline tooltip | 延迟 Tooltip 打开后才计算计时文案 | 没有打开 Tooltip 的 render 不执行逐 span label 格式化 |
| 后继 Assistant 查找 | 一次反向遍历为每个输入位置记录后续 Assistant | 原先重复向前查找的最坏复杂度从 `O(C²)` 降为 `O(C)` |
| Group duration | 以固定十进制分组替代固定英文数字形态下的 `toLocaleString('en-US')` | 复杂度仍与 Group 数线性相关，但重复 render 路径不再调用 Intl formatter |

展示 memo 与搜索索引彼此独立。搜索覆盖当前 React 可见历史窗口中的屏幕外 record，并允许实时变化延迟一个 throttle 周期；Table 必须立即更新发生变化的可见 record，不能继承索引的提交节奏。

## 考虑过的替代方案

**保留独立 Session History fold，只做局部优化。** 不予采纳：缓存可以降低部分热点，但 Trajectory 仍会在 Chat 之外拥有第二套 Event 窗口、分页修复、request inspection fold 与业务关联实现。

**复用 Chat Definition，并在 `buildViewNode()` 中按 `target` 分支。** 不予采纳：Trajectory 需要不同的 State 与中间 record，不只是另一套 React renderer。单一 Definition 会携带两个视图的 payload 与条件，并在任一视图变化时让无关 target 数据失效。

**创建 Trajectory 专属 Assembler。** 不予采纳：精确 ID 路由、先 update 后 start 的收集、prepend replay、Location 修复、Reader 依赖与发布节奏都不是 Trajectory 特有行为。第二套引擎会重新制造本次改造要消除的生命周期重复。

**增加通用 Surface、rewind、fanout 或 settled 生命周期。** 不予采纳：当前持久 Event stream 不需要通用 Surface branch；Session 或 Turn boundary 是 target 业务输入，不构成把一个 Event fanout 到全部历史 Context 的理由。完成条件仍由业务 State 结合 Location closure 判断。

**用通用 Conversation Node 替换 Trajectory stage。** 不予采纳：stage 为单一视图组织 Request、计时、schema 和表格 layout。把它变成引擎约定会限制未来的朴素 Session-log 视图，并把视图专属组合重新放回 Client Runtime。

**在展示与搜索之间共享一套 Markdown cache。** 不予采纳：展示要求立即更新且受 viewport 约束，搜索则覆盖全部 React 可见 record，并有意批量提交更新。共享 cache 会把两个无关消费方的正确性与调度节奏耦合起来。

## 验证

Runtime 测试固定 target 注册、首次订阅 activation、精确 ID append、先 update 后 start 的 replay、prepend identity、Reader window-gap 修复、Location replay，以及 Chat 与 Trajectory snapshot 隔离。

Trajectory Definition 与 Builder 测试固定 Assistant streaming 与 interruption、嵌套 Tool call 和并行 interruption、Compaction 与 prompt 继承、Steering 分类和 Step 位置、Request 标记顺序、稳定 contribution 替换与 prepend 扩展。Table、layout、Timeline 与搜索测试固定延迟 Markdown 工作、节流索引更新、Tooltip 展示时格式化，以及 append/prepend 期间稳定的搜索结果。

## 后果

Trajectory 业务组装的成本随变化页面或 keyed Context 增长，不再从完整原始 Event 窗口重新开始。target 自有 Definition 可以独立于 Chat 演进，同时继续共享一份 Session 窗口和一套生命周期规则。steering 会在实际所属 Step 位置成为一等 Trajectory record，不需要向 Session 增加 steering 专属状态。

首次激活后，保留的 stage-oriented Builder 仍会执行与已物化 Trajectory contribution 数量成正比的工作，并可能在发布时排序。激活前，target 保留 Context State 和一个 target 索引，但不保留 Builder、已物化 Node 或 snapshot。每次挂载 Trajectory 视图时，React layout、timeline 与搜索数据都锚定在当前尾部的 50 个 target Node；实时 append 会扩展该窗口，现有更早历史操作则先扩展其前缀，再请求下一个 Session 页面。如果 replacement window 不再包含先前的尾锚，同一次 render 会以替换窗口的最新 Node 为边界，并把该节点采纳为后续 append 的新锚。请求编号与累计用量仍从完整的驻留 snapshot 派生。输入 layout 变化时，搜索索引仍会执行一次轻量线性签名检查。

Definition 作者必须提供稳定的协议标识。缺少必要 ID 的旧 Event 可能不会出现在受影响的 Trajectory 业务视图中；与合并无关记录或让历史加载失败相比，这是更安全的退化方式。要求完整展示的生产方必须记录该标识。

[Conversation assembly 决策](2026-08-09-client-conversation-node-assembly.zh.md)继续作为通用 Context、Reader、Location 与发布约定的真源。[Trajectory ledger 决策](../feature/2026-07-27-trajectory-inspection-ledger.zh.md)继续负责表格层级、虚拟化、检查器和交互行为。本 Note 负责说明 Trajectory 如何适配这两项决策，以及为何该适配不与 Chat 共享最终 Node。
