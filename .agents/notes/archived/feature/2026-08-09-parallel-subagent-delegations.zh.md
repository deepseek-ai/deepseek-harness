# Agent Note: 并行 subagent 委派

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-parallel-subagent-delegations.md) | 中文

## 问题

想要扇出的模型会把多个 `subagent` 调用合并进同一条 assistant 消息：这个批次本身就是并行意图。委派工具此前没有声明 `isConcurrencySafe` 分类器，按安全侧原则设计的调度器（[并行工具调用 Agent Note](2026-07-10-parallel-tool-call-execution.zh.md)）便把每个前台委派都当作独占屏障：GUI 里显示九张卡片，却只有一个子 agent（智能体）在运行，其余八个要在它的整个运行期间排在其后等待。

最初的保守立场（一元分类器无法证明同级委派的工作区效果互不相交）已经不再保护任何东西：`run_in_background: true` 和可继续委派本来就会与其后的每个调用重叠执行，包括写入；`dsh-workflow-worker-thread` 也早已通过同样的 `ctx.subagents.start()` 提供方在共享工作区上并发运行子 agent，数量可达其并发上限。只有前台形态被串行化。

## 决策

`dsh-tool-subagent` 为每种调用形态（前台、一次性后台、可继续）都声明 `isConcurrencySafe: () => true`，因此同一 assistant 步骤中的同级委派会在循环的滚动池下重叠执行，上限为 `maxParallelToolCalls`，结果仍按模型顺序提交。

该声明在结构上满足调度器的安全约定：子 agent 在自己的会话中工作，运行绝不变更父会话（启动时追加的 `sandbox/mode`、`approval/policy`、`subagent/descriptor` 只落在子 agent 自己的日志里），工具把输出返回给循环，由循环按顺序提交。一次性后台形态对父级拥有状态的唯一写入是通过 `tasks.start` 注册一个 Task——这是一次同步、可交换的插入，满足的是调度器 Agent Note 中的共享状态条款，而非更强的「无变更」性质。提供方 seam 要求针对不同子 agent 的并发启动和可继续准备分别隔离操作局部状态、取消、结算和清理。内置提供方满足这项约定：spawn 和 fork 在各次启动之间不保留可变状态，fork 只读取父级已完成轮次的前缀，进程外提供方按每次运行分配状态，继续执行管理器则为每次准备预留唯一的子 agent 身份和锁。

协调同级工作区效果是模型的职责，产品对后台、可继续和工作流子 agent 已经采取同样的立场。同类 harness 的做法一致：Claude Code 的 Task 工具无条件并发安全（上限 10）；oh-my-pi 的 task 工具默认归入其可重叠的 `shared` 类别；opencode 的 task 工具在其 SDK 下不设上限地运行；Codex 则把委派做成异步 spawn/wait 信箱，绕开了这个问题。

容量控制仍保持在调度器 Agent Note 所定的位置：`maxParallelToolCalls` 限制单个步骤中未结算的工具调用数量——因而也限制并发运行的前台子 agent 数量——而后台和可继续调用在启动时即结算并释放池位，它们留下运行的子 agent 不受该上限约束。LLM（大语言模型）提供方负责自身的容量控制。

## 测试

包测试固定了两种调用形态的分类器。一个门控测试直接驱动注册表，其两个子 agent 各自阻塞，直到两者都已启动，以此证明该声明所依赖的那一半：工具体和提供方启动路径能容忍并发分发——这条栈中任何隐藏的串行化都会造成死锁，而不是静默通过。一个可继续门控测试让两项提供方准备停在同一个 await 上，在发布前取消其中一个调用方，并证明已取消的子 agent 不会留下 agent 或持久会话，而其同级则到达 inbox 接受状态并独立持久化。另一半（分类真正产生重叠执行）由分类器 pin 测试和下述快照负责。

人工编写的 `subagent-parallel` 快照固定了组装后应用的 transcript（文本记录）：一条 assistant 消息携带两个 subagent 调用，父级日志记录为 `tool/call, tool/call, tool/result, tool/result`（串行执行会让调用/结果成对交错出现），两个子 agent 各自作为独立会话完成。其中的孪生委派刻意做成完全相同：`dsh-llm-replay` 按首次调用顺序绑定子脚本，harvester 按 `createdAt` 对子 agent 排序，二者在并发子 agent 之间都不具确定性（即 `XXX(concurrent-subagents)` 标记），因此只有可互换的孪生委派才能确定性回放。

## 备选方案

**保持委派独占。** 现状没有保护任何东西：后台和工作流子 agent 本来就可以带着写入自由重叠，串行化前台形态只会增加延迟，还违背模型显式表达的批量意图。

**使用输入敏感的分类器。** 该调用的参数只有自由文本的描述和提示词；其中没有任何内容能区分安全委派与不安全委派，因此条件式分类器只会流于形式。

**按 Codex 风格重新设计为异步 spawn/wait。** 可继续子 agent 加上 `send_message` 已经提供了异步通道；围绕信箱重建前台约定，等于为了解决一条声明就能修复的调度问题，丢弃一条可用的同步结果路径。

**按实例提供 `concurrencySafe` 配置开关。** 没有消费方需要串行部署：`maxParallelToolCalls: 1` 已能恢复全局串行执行，同类 harness 的先例也默认委派并发安全。

## 影响

同级子 agent 可能在共享工作区或外部资源上发生竞态；这项协调由模型负责，正如模型对其他所有重叠子 agent 已经承担的那样。并发子 agent 还会争用 LLM 提供方配额；`maxParallelToolCalls` 只限制未结算的调用，不限制后台或可继续调用留下运行的子 agent。

同一条消息中的两个一次性后台委派按分发竞态顺序获得各自模型可见的 job id（`subagent-<n>`）。这些 id 已被记录，因此回放仍然有效；但需要区分后台子 agent 的快照场景会继承与孪生子会话相同的确定性约束。

有序提交可能让快速子 agent 的结果排在更早的缓慢同级之后等待，这是[调度器 Agent Note](2026-07-10-parallel-tool-call-execution.zh.md)已经接受的取舍；实时界面仍会展示每个子 agent 各自的进度。

使用不同提示词的并发子 agent 快照场景仍需要回放 harness 的支持（确定性的子脚本绑定与收集排序）；在此之前，此类场景必须使用可互换的孪生委派。
