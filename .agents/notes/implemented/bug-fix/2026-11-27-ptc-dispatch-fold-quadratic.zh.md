# Agent Note：PTC 分发折叠的线性化

Status: implemented

[English](2026-11-27-ptc-dispatch-fold-quadratic.md) | 中文

## 问题

在 Web GUI 中打开一个真实的 computer-use Session 时，对话要等数秒才出现。会话 JSONL 解压后有 50,294 个事件，其中 49,258 个是嵌套 PTC 分发事件：24,629 个 `tool/ptc-dispatch-start` 和 24,629 个 `tool/ptc-dispatch`，单个父调用下最多有 20,480 个子调用。客户端以 `maxMessages: 500` 和 `turnWindow { minMessages: 50, minTurns: 2 }` 请求有界尾部，实际窗口却有 50,260 个事件，几乎是整个日志。[Chat Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) 折叠该窗口用时 8,950 ms。它的 `updateDispatch` 对每个分发事件都用 `findIndex` 查找子调用、复制父调用的整个子节点数组，并把全部父子关系复制进新的 `Map`，因此单个父调用下 n 个子调用的成本为 O(n²)。

[Trajectory Tool Definition](../../../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts) 有同样的结构。它的 `updateDispatch` 对每个分发事件都用 `indexOf` 搜索父调用的子调用 id 列表并复制调用 Map；首次挂载时还复制子节点 Map、父节点 Map 和父调用的子调用 id 列表。每个根 `tool/result` 再复制一次调用 Map。[Web 组合](../../../../packages/bundle/web-app/cordis.patch.yml)默认启用 ui-trajectory，而 Assembler 无论目标是否激活都会更新所有已注册的 Definition，因此这项成本作用于每次打开 Chat，而不仅是 Trajectory 标签页。

## 决策

两个 Definition 都在 State 中持有 `DispatchTree` 并原地修改。分发更新以及 Trajectory 的根结果更新返回同一个 State 对象；`start()` 仍新建 State，因此重放从新树开始。[Assembler 更新规则](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)允许返回原地修改后的 State，因为 Assembler 不按 State 引用判定发布。返回同一 State 的做法参考了 imccyu 的 #9400。

Chat 的树用 `Map<parentCallId, Map<subCallId, ToolCallBlock>>` 按首次挂载顺序保存子节点，另用 `Map<subCallId, parentCallId>` 支持环检测和深度检查。`updateDispatch` 把子节点写入或替换到父调用的内层 Map，因此替换是幂等的，首次挂载决定顺序，一次分发只做 O(1) 的 Map 操作。`projectBlock` 在发布时把每个父调用的内层 Map 值物化成新数组。

Trajectory 的树保留该 Definition 原有的索引：一个按调用 id 保存根调用和每个已接受子调用的调用 Map、按首次挂载顺序排列的子调用 id 列表，以及父节点 Map。Chat 采用内层 Map，是因为它的 State 没有按 id 索引的调用 Map，而重复结算必须在常数时间内找到父调用下的子调用。Trajectory 保留单一调用 Map，是因为该 Map 已经提供这种查找，保留它也就对每个 id 保持了原有的接受与替换行为，包括与根调用 id 相同的子调用 id。由于 `acceptsEdge` 保证每个子调用至多有一个父调用，一条边存在当且仅当父节点 Map 记录的正是该父调用；这取代了 `indexOf` 扫描，且不改变哪些事件被接受。一次分发写入调用 Map，首次挂载时再追加一个 id 和一条父节点记录；根结果就地写入根条目。`projectCall` 仍在每次发布时新建投影树。

两个目标发布出的 Tool 调用块都持有自己的数组，绝不与分发树共享引用，下游代码保留不可变值语义。每个事件按逻辑 `seq` 顺序只折叠一次。

[conversation-fold 基准](../../../../benchmarks/conversation-fold/conversation-fold.bench.client.ts)的用例 `conversation-fold/ptc-dispatch-fan-out` 运行其 [worker](../../../../benchmarks/conversation-fold/conversation-fold.worker.client.ts) 的 `ptc` 入口。worker 在 Chat Definitions 之外注册 Trajectory Tool Definition 和 Trajectory 视图，与默认 Web 组合一致。用例合成两个根调用，每个根调用有 10,000 个已结算的嵌套分发：每个子调用包含一个 start 事件和一个 settle 事件，共 40,004 个事件。它分别在激活 Chat 和激活 Trajectory 时各折叠窗口三次，各取最快样本。它断言每个目标的快照都包含 20,000 个子调用且全部为已结算 tool-result。两个目标共用一个 100 ms 的参考机预期，经 `ciTimeBudget(100)` 得到 250 ms 预算，即共享的 2× CI 时间倍率与 1.25× 余量。[前端性能预算](../testing/2026-09-06-frontend-performance-budgets.zh.md)记录将此用例列入 conversation-fold 基准。

## 校准

所有测量都在 macOS arm64、Node 26.0.0 上于纯 Node 下运行编译后的基准 worker。改动前数值来自同一 worker，两个逐事件复制实现都从 master 恢复；它们是负向对照，并非历史 checkout。改动前各行为一个样本，改动后各行为三次中的最快值。

| 单个父调用下的嵌套分发数 | 改动前，激活 Chat | 改动前，激活 Trajectory | 改动后，激活 Chat | 改动后，激活 Trajectory |
|---|---:|---:|---:|---:|
| 1,000 | 97 ms | 89 ms | 4 ms | 3 ms |
| 2,000 | 372 ms | 352 ms | 8 ms | 7 ms |
| 4,000 | 1,511 ms | 1,516 ms | 17 ms | 12 ms |
| 8,000 | 6,680 ms | 6,327 ms | 32 ms | 22 ms |
| 2 × 10,000（基准形状） | 29,176 ms | 22,483 ms | 58–63 ms | 53–59 ms |

改动前每翻一倍耗时约增至四倍；改动后耗时翻倍。只恢复其中一个 Definition 仍会让两个目标都呈二次增长，因为 Assembler 会更新两者。在基准形状上，只恢复 Chat 实现时，必跑用例测得激活 Chat 9,073 ms、激活 Trajectory 8,035 ms，超出 250 ms 预算而失败。只恢复 Trajectory 实现时，一次 worker 样本测得 12,078 ms 和 11,496 ms，必跑用例超过 60 秒的 worker 时限。

在真实的 50,260 事件窗口上，完整 Chat 折叠从 8,950 ms 降至 112 ms。同一窗口的分阶段测量记录 match/update 从 9,365 ms 降至 102 ms，发布阶段从 17 ms 降至 10 ms。这些数字是在 Trajectory 改动之前用 Vitest 源码 harness 测得的。

## 备选方案

- **保留数组并用子调用 id 建索引。** 每个父调用加一个 `Map<subCallId, index>` 可以省掉 `findIndex`，但每次分发仍要复制不断增长的数组和全部父子关系，二次复制依然存在。
- **在 Chat 中就地追加数组，只在发布时复制一次。** 这同样能去掉逐事件复制，但 Chat 的 `updateDispatch` 仍须在折叠期间拒绝环和深度溢出；数组加父子映射会重复内层 Map 已提供的索引，重复结算还需要扫描或第二个索引。
- **让 Trajectory 采用 Chat 的内层 Map 布局或共享模块。** 不采用：两个 Definition 刻意保持独立，而 Trajectory 的单一调用 Map 对每个 id 都保留了原有的接受与替换行为。
- **像 Chat 一样缓存 Trajectory 投影。** 不属于本次改动：冷折叠中每个根调用只发布一次，而每次发布都重建是 Trajectory 的既有行为。
- **只折叠或渲染 PTC run 的有界前缀。** 不采用：一个轮次可以合法包含整个 run，父调用的嵌套调用没有可按消息分页的边界，隐藏子调用改变的是用户可见的工具树，而不是消除折叠成本。

## 影响

两个 Definition 中一次分发现在都只做常数级 Map 操作，因此包含宽 PTC 扇出的 Session 按其事件数线性打开。每棵树为每个调用和每条子调用边保留一个条目，与原先复制的 Map 和数组内存数量级相同。发布时仍按父调用物化数组，所以每棵发布树都是不可变值。Chat 的投影缓存复用未变化的块；Trajectory 在每次发布时重建投影树。

任一逐事件复制回归时，该用例都会在一次基准运行内让 CI 失败。它覆盖冷折叠中两个根调用下的已结算嵌套分发；不覆盖每次分发后都重新发布的实时追加、仍在流式到达的分发事件、错误结果或接近 256 层深度上限的调用树。墙钟预算仍需在新参考机上重新校准；250 ms 的 CI 预算来自共享倍率，而不是本用例的托管实测。

现有 1,066 项 ui-chat 测试（包括 [turns 与 tool-call-tree](../../../../packages/client/ui-chat/tests/tool-call-tree.client.spec.ts)）和现有 ui-trajectory 测试全部通过。[Trajectory 对话 Definition 测试](../../../../packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts)新增挂载顺序、重复 start、环、改挂父调用、收养游离子树以及由结果重建根调用的用例；这些用例在逐事件复制实现上同样通过。两个 Definition 文件都因 `vitest.config.ts` 对 ui-chat 对话节点和 ui-trajectory 源码的排除项而不在逐文件覆盖率门禁内；用各自包的测试测量，`tool.ts` 行覆盖率为 98.56%，`trajectory-tool-definition.ts` 为 97.84%，其余缺口是防御性路径和非分发路径。真实会话日志仅用于本地诊断，没有任何日志内容进入仓库或 fixture。
