# Agent Note: PTC mode 的实时分发生命周期，以及复用原生约定的并行执行

Status: implemented

[English](2026-07-26-ptc-live-parallel-dispatch.md) | 中文

> 范围：`tool/code-dispatch-start` 事件、Web chat 中每个子调用的运行状态，以及桥接层调度器对原生并发约定的复用。构建在[宿主侧基础](../../archived/feature/2026-07-26-ptc-dispatch-ui-foundation.md)与 [chat 子调用行](../../archived/feature/2026-07-26-ptc-chat-subcall-rows.md)之上；原生约定本身归[并行工具调用 Agent Note](2026-07-10-parallel-tool-call-execution.zh.md) 所有。

## 问题

宿主侧基础与 chat 子调用行交付之后仍留有两个缺口。子调用行过去只在每次分发*结算*后才出现：某次分发运行期间，UI 对它毫无展示，于是一个慢的子调用看上去就像父调用卡住了。而桥接层过去把每一次绑定调用都串行化（「即使 `Promise.all` 也一次只执行一个」），这是工具尚未携带并发元数据时留下的占位实现：如今 `isConcurrencySafe` 已经存在，agent loop（智能体循环）调度器早已在有界并发池中运行原生兄弟调用，而一个等待三个独立读取的 PTC mode 程序，付出的延迟却是原生路径的 3 倍。

## 决策

**一对生命周期事件，一份调度约定，与原生共用。**

- **事件对**：`tool/code-dispatch-start`（父/子 id、名称、规范化参数）在调度器真正启动某个调用时才追加，而非在提交时，因此因 run 结算而被放弃的排队调用不会留下任何日志。既有的 `tool/code-dispatch` 结算该事件对（`subCallId` 相同）；每个已启动的调用恰好结算一次（中止也会作为 `isError` 结果经由流水线结算）。计时即这两个事件的 `time` 字段。两个事件仍仅用于日志；模型上下文不受影响；格式保持 v0。
- **桥接层调度器**：已提交的调用在启动那一刻经 `registry.executionMode` 分类（与 loop 所用完全相同、故障时默认判为不安全的 `isConcurrencySafe` 约定），并严格按提交顺序启动。所有有序阶段——start 事件追加、`prepare`（pre-execute/守卫）、队首 `finalize`/`finish` 提交（post-execute + 上下文延迟提交 + settle 事件追加）——由单通道驱动器独占执行，因此有序策略阶段彼此绝不重叠，只有 around-dispatch/工具体阶段并发运行，与原生 loop 的时序完全一致（`fillPool` 先 await `startCall` 再 `commitReady`）。连续被分类为可并行的调用可以重叠执行，上限为 `maxParallelSubCalls`（`Config` 字段，Loader schema 校验之外直接构造时也重新校验，默认值 10，即 loop 调度器自身的默认值；设为 `1` 即恢复串行分发）；独占调用则先排空池、独自运行，且其屏障保持到自身提交（含 post-execute）完成为止，与原生独占分组一致。run 结算时会中止仍在运行的分发，并放弃已排队未启动的分发（绑定调用被拒绝，不产生事件），随后排空到完全停稳——包括程序返回时已在途的提交——之后外层结果才结束该轮次。
- **客户端侧**：运行时的 `ToolCallTree` 把 start 事件存为 `RunningToolCall` 子级，并通过父级递归的 `subCalls` 投影出来（行组件从该形状推导出运行指示环，与原生运行中的调用处理完全一致）。其结算事件会原位替换私有索引中的条目，即使并行完成也保持启动顺序不变，并把 start 事件的 `time` 作为 `callTime`（时长来源）带入。未观察到对应 start 的结算事件（窗口切在事件对中间，或日志录制于 start 事件引入之前）会直接追加，因此旧日志仍能照常渲染。
- **SDK 提示词**：面向模型的「调用按顺序执行」一句替换为真实约定（相互独立的安全调用可以在 `Promise.all` 下重叠执行；相互依赖的工作以 `await` 顺序衔接）；这是模型可见的变更，每一份 PTC mode 快照都已重新录制。

## 曾考虑的替代方案

**不加限制的并行（让 `Promise.all` 重叠一切）。** 否决：写操作可能产生竞态；原生调度器之所以存在，正是因为安全性声明归工具所有，而不归调用方。原生与 PTC mode 使用同一套并发词汇，是已敲定的要求。

**在提交时而非入池时发出 start 事件。** 否决：提交即发 start 会把排了队却从未运行的调用显示成「运行中」，还得强行引入第三种「已放弃」终态事件才能使日志自洽。入池才发 start 保住了*已启动 ⇔ 恰好结算一次*这一不变式，且不需要第三种事件。

**直接复用 loop 调度器的实现。** 否决：loop 调度的是一个已完整解析的批次，并按模型顺序提交结果；桥接层调度的则是一条开放式的提交流，其结果返回给程序，而不是进入 transcript（文本记录）。因此两者共享的只是*约定*（分类、池、屏障），而不是实现机制。

## 后果

程序不需要任何新的模型侧 API，独立读取就获得了原生级的延迟：`Promise.all` 直接变得更好用，提示词指引也随之修改。Web UI 实时显示每个子调用的运行指示环：fixture（测试前置数据）发出成对的 start/settle 事件；jsdom 锁定运行中形状；运行时测试锁定原位结算、乱序完成与 callTime 配对。trajectory/waterfall 的子调用 span 从这对事件取得如实的计时。spill 边界划定（[ptc-dispatch 日志 spill](../../archived/feature/2026-07-26-ptc-dispatch-log-spill.md)）则以结算事件作为唯一的边界点。
