# Agent Note：统计面板对宽 PTC 调用的线性折叠

Status: implemented

[English](2026-11-27-ptc-stats-panel-quadratic-fold.md) | 中文

## 问题

统计视图把每个 Session 窗口折叠成「每个 step 一个节点、每个 Code-Mode 根调用一个节点」。一次 PTC `run_code` 调用可能派发上万个嵌套子调用，而[折叠](../../../../packages/experimental/client-ui-stats/src/client/stats-fold.ts)对每个事件都浅拷贝两个随子调用数增长的对象：`tool/ptc-dispatch-start` 里的 `starts`，以及 `tool/ptc-dispatch` 里的 `calls`。于是单个根调用（n 个子调用）要做 O(n²) 次浅拷贝，仅折叠就要耗时数秒，面板迟迟无法渲染。

[Chat 与 Trajectory 的 Tool Definition](2026-11-27-ptc-dispatch-fold-quadratic.zh.md)已经把各自的调用树折叠线性化；本包折叠的是自己的 per-step 记录，那两处修复并不覆盖它。

发布侧同样如此。[`codeModeDefinition.buildViewNode`](../../../../packages/experimental/client-ui-stats/src/client/stats-definition.ts) 在每个分发事件上都调用 `stepMetrics(state)`，把完整调用索引物化并排序，最终却只输出至多 `CALL_LIMIT`（12）行；该 Definition 又没有声明发布节奏，装配器于每个分发事件都 flush 一次并重建目标快照。

## 决策

同一个 Context 的四个折叠集合改为它独占、就地增长的 `Map`：`pending`、`tools` 负责工具计数，`calls` 保存已记录的调用，`starts` 保存分发开始时间。`update()` 返回同一个 State 对象，[Assembler 更新规则](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)允许这样做；`start()` 仍新建 State，因此重放时从空集合开始折叠。分发开始时间在对应的结算事件读出后立即 `delete`，这条记录的唯一用途是量出一次耗时。

调用列表不再对索引排序。同一个 Context 收到的 match 一律按 `seq` 递增到达，且每个调用 id 只由首次记录它的事件创建一次，因此插入顺序就是表格列出的顺序。`callList` 顺着索引遍历，取到 `CALL_LIMIT` 行就停止，途中顺带应用单个 step 的文本预算。

Code-Mode 节点改为通过 `innerCalls` 直接物化这段有界前缀，同时滤掉 step 行要用真实子调用替换的嵌套 `run_code`；发布时不再调用 `stepMetrics`，因为它的其余字段在这一类节点上全部被丢弃。只要可见前缀、锚点和 Location 不变，该 Definition 就复用上一次返回的节点对象；目标构建器在整批 upsert 都是已持有节点时，也保持当前快照不变。这份复用读的是装配器为该 Context 保存的那个节点，Definition 自己不另建缓存。分发更新改申请 `animation-frame` 发布，装配器会在三个浏览器动画帧之后才物化这样的发布，因此宽运行的多次分发合并成每三帧至多一次发布。

一个 Code-Mode Context 至多保留 `CALL_LIMIT` 条调用记录。结算事件只在「这条记录还进得了已发布前缀」时才写入：名字要能被 step 行展示（`!isCodeMode(name)`），且索引当前短于 `CALL_LIMIT`。已经保留的记录仍就地替换，所以重复结算照样更新自己那一行。分发分支自己维护的计数照旧覆盖每一次分发：`tools` 统计每个上报的工具名，`toolErrors` 记下每一次失败。调用路径上的 `toolPairs`、`toolMs`、`toolOpen`、`toolMissing` 由原生 `tool/call`、`tool/result` 分支更新，Code-Mode Context 根本收不到这些事件，所以保留上限影响不到它们。step Context 保留全部外层调用，因为它的 `tool/call`、`tool/result` 路径没有改动，保留上限只落在只有 Code-Mode Context（及其 `fallbackState` 重放）会走到的分发分支上。

这个上限是安全的：Context 内部没有任何读者使用被丢弃的记录——发布出的 inner 贡献和 [stats-aggregate](../../../../packages/experimental/client-ui-stats/src/client/stats-aggregate.ts) 里的 step 合并，消费的都只是保留下来的前 `CALL_LIMIT` 条可展示分发。也正因为嵌 `run_code` 的分发不占这些槽位，派发了嵌套 runner 的运行会比以前多列出几条真实调用。代价是放弃了「展开查看全部嵌套调用」这类视图：将来要做，必须从 Session 事件里重新推导（或另建保留策略），不能指望从这份 State 里恢复。

## 校准

表中所有数字都来自[包内诊断](../../../../packages/experimental/client-ui-stats/tests/ptc-dispatch-fold.perf.client.ts)，机器为 macOS arm64、Node 24.18.0，运行命令 `pnpm exec vitest run --config vitest.web.perf.config.ts packages/experimental/client-ui-stats/tests/ptc-dispatch-fold.perf.client.ts`。「改造前」的数值是把改造前的源码取回工作树后跑同一份诊断得到的，负载、harness 与断言完全一致。`fold` 指把同一批事件折叠进一个 Code-Mode State，`publish` 指构建一次节点，`republish` 指对同一 Context 再构建 50 次的平均耗时，`live` 指把每个事件逐个 append 进真实的 `ConversationNodeAssembler` 并激活统计目标。

| 子调用数 | 事件数 | 折叠前 | 折叠后 | 发布前 | 发布后 | 复发布前 | live 前 | live 后 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 000 | 2 006 | 101.6 ms | 0.9 ms | 0.311 ms | 0.058 ms | 0.068 ms | 244 ms | 9 ms |
| 3 000 | 6 006 | 1 035.9 ms | 0.8 ms | 0.476 ms | 0.002 ms | 0.507 ms | 4 371 ms | 13 ms |
| 10 000 | 20 006 | 13 945.5 ms | 2.2 ms | 2.507 ms | 0.004 ms | 2.139 ms | 63 434 ms | 35 ms |

改造前，子调用数每翻三倍，折叠耗时约涨到 10～13 倍；改造后任何规模都稳定在 3 ms 以内，live 窗口从 9 ms 增长到 35 ms。各规模下保留的调用记录恒为 `CALL_LIMIT`（12）条，也没有残留的分发开始时间。这套 harness 里 live 仍然是每个事件发布一次，因为 Node 没有 `requestAnimationFrame`，`animation-frame` 会退化为立即发布；浏览器端则按帧合并这些发布。

## 备选方案

- **保留 Record，发布时复制一次。** 每个触发发布的事件仍要遍历一个不断增长的对象，平方项只是换了位置；而且 Code-Mode 节点为了列出 12 行不得不重建整个索引。
- **给 Code-Mode Context 复用共享的 `DispatchTree` 模块。** 先前的两个 Definition（[Chat](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) 和 [Trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts)）折叠的是带父子关系与准入规则的调用树；这里折叠的是每个 step 的扁平列表，没有嵌套，为一个消费方引入跨包模块并不划算。
- **继续按 `seq` 排序。** 排序防御的是「插入顺序与事件顺序不一致」，而只追加的折叠产生不了这种状态：Context 拒绝非追加的 match，每条记录的 `seq` 就是创建它的那个事件的序号。现在这条不变式写在 `callList` 的注释里，而不是每次发布付一次 `O(n log n)`。
- **只限制发布出的前缀。** 这样发布成本是降下来了，但 Context 仍按子调用数保留每个记录，内存依旧随运行规模增长；而折叠本身在两种做法下都已经是常数。
- **分发更新返回 `'none'` 完全不发布。** 正在运行的 `run_code` 行会一直看不到 inner 调用，直到有其他事件触发 flush 才更新。`animation-frame` 既保持了面板的实时性，又把频率限住。
- **把发布过的节点缓存进 Context State。** State 对其他分支是只读契约；按 State 索引的 `WeakMap`（Chat Definition 已用同样方式缓存投影块）能让缓存留在契约之外。

## 后果

一次分发只做常数次索引操作，因此宽 PTC 调用的开关成本与事件数成正比，面板也不必为了显示 12 行而重建整张调用表。每个 Code-Mode Context 最多保留 `CALL_LIMIT` 条调用、且不再残留已结算的开始时间；运行的真实总量仍记在标量计数与工具计数里。

`packages/experimental/client-ui-stats` 的既有测试全部通过，发布输出不变。有三处断言随它们所固定的实现一起调整：State 集合改为 `Map`；调用顺序用例的 fixture 改为按 `seq` 递增构造，因为旧 fixture 故意让 key 顺序与 `seq` 相反；Code-Mode Definition 新增了发布节奏声明。包内测试补充了保留上限、已保留分发的就地替换、同节点复发布，以及节点未变时跳过快照重建；该包 17 个源文件的逐文件覆盖率仍为 100%。

诊断不设阈值、不进入任何 CI 通道，所以线性度靠复跑诊断来验证，而不是靠门禁。它覆盖的是单个根调用在冷折叠与 live 追加下的情形；没有覆盖同一 step 内的多个根调用、仍在流中的分发事件、错误结果，以及整段前缀共享文本预算的情况。
