# Agent Note: 可继续的后台 subagent

Status: implemented

[English](2026-07-21-continuable-background-subagents.md) | 中文

本记录已由[可继续的 subagent](2026-07-28-continuable-subagent-conversations.zh.md)取代——后者以一个持久 Session 加至多一个进程内 Activation（驻留期）替换了其基于 Task 的 activation 模型、路由、取消和持久性语义。其服务放置与提供方功能策略此前已由[将 subagent 控制合并到 subagent 服务](../simplification/2026-07-26-merge-subagent-control-service.zh.md)和[以意图命名的 subagent 继续执行操作](../simplification/2026-07-27-intent-named-subagent-continuation-operations.zh.md)取代。仅持久 child 会话与 descriptor 的设计依据仍然有效。

## 问题

subagent 工具将每次委派视为一个独占的 `SubagentRun`：前台调用和后台 Task 收集结果后 dispose（资源释放）该 run。这种所有权关系能够限制存活 child agent（智能体）的数量，并释放其作用域服务、监听器及提供方资源。持久化的 child 会话可能继续存在，但 parent 缺少持久化目录和工具路径，无法发现该 child 并为其启动另一轮次。

Task、run 和 child 会话具有不同的生命周期。一个 Task 表示一轮后台执行，并且只有一个终态结果。一个 `SubagentRun` 拥有 child 的一次激活。一个持久化 child 会话可以包含多个由 parent 或用户发起的轮次。继续执行必须保留逐 run dispose 的约定，而不能把所有历史 child agent 都留在内存中。

## 决策

一个可继续的后台 subagent，是由一系列 Task 支撑的短期激活共同组成的持久化 child 会话。child session id、transcript（文本记录）、谱系及声明的组合配置均保留在持久化存储中。每次初始激活或恢复激活都会创建新的 Task、`AgentHandle` 和 `SubagentRun`，驱动一个轮次、收集结果，并在 Task 进入终态前 dispose 该 run。

Task 的结果和取消边界属于 child 激活，不属于为该激活提供第一条消息的调用方。Task 访问根据 parent session id 授权，而 Task 注册表仍保留当前存活的精确 parent Agent 实例，用于通知与资源清理。因此，只要 parent 仍是运行时 owner，parent 消息和用户消息便会共享同一个激活结果：

```text
durable child Session
  activation 1: Task 1 -> SubagentRun -> AgentHandle -> dispose
  activation 2: Task 2 -> SubagentRun -> AgentHandle -> dispose
  activation 3: Task 3 -> SubagentRun -> AgentHandle -> dispose
```

前台委派保持一次性行为。继续执行覆盖后台的进程内 spawn 和 fork child。每个 `tool-subagent` 实例都会选择 `backgroundMode: 'one-shot' | 'continuable'`；配置为可继续模式时，所挂载提供方必须具备 `resume` 功能，而可恢复的提供方仍可采用一次性后台策略。在下述 ACP（Agent Client Protocol）后续工作完成前，ACP child 仍保持一次性行为。

`ctx.subagents` 是唯一的公开服务。普通 `start` 不感知 child 集合、Activation 与持久化：它校验提供方功能、解析一次性描述符、分发一个 run、观察 run 生命周期，并返回由持有方负责的 run。注入的内部继续执行管理器负责管理稳定的 child id、可继续描述符持久化与查找、Activation 生命周期，以及通过 `startContinuable` 和 `followup` 进行的路由；管理器自行组合 child 之前，提供方通过私有闭包提供准备数据。按提供方绑定的 `@deepseek-ai/dsh-tool-subagent` 插件及面向用户的适配器调用这些意图操作来处理可继续后台工作；前台和一次性后台委派使用普通 `start`。全局命名的模型工具是 `@deepseek-ai/dsh-tool-subagent-control` 中的可选轻量适配器，它是否存在不会决定是否启动可继续工作。parent 到 child 的枚举、一次性／可继续模式共享的描述符身份与 `list_agents` 属于[持久化 subagent 目录](2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)。

### Task 与取消的所有权

初始后台委派请求 `ctx.subagents` 启动 child 并注册其 Task。可继续提供方只有在确认本次激活的最终会话状态已持久化后，才会返回成功的 run 结果。Task 结算流程等待该结果，通过继续执行管理器的结算路径调用 `run.dispose()`，然后才记录 `JobOutcome`；`job_kill` 中止活跃 run，其结算路径仍会 dispose 该 run。因此，终态 Task 会留下持久化 child 会话，但不会留下存活的 child agent。必需的持久性检查点若没有已安装的监听器或任一监听器失败，run 会以稳定错误码 `DURABILITY_FAILED` 拒绝，并将检查点失败保留为失败原因；管理器会记录失败的 Task，其详情说明最新状态未确认已持久化，因此恢复时可能不可用或已陈旧。

后续每个轮次都会创建另一个 Task。该轮 producer 持有的执行资源仅服务于这次激活，不属于 child 会话。它只会到达一次终态、只产生一个结果，也不会重新打开。Task 注册表中当前注册的那个存活 parent agent 实例仍是其 owner：dispose 该实例会取消、等待并移除其 Task。Task API 会授权 session id 与该 owner 匹配的调用方，但 id 相同的替代实例不会成为通知或资源清理目标。这一设计保留 `settleRun()` 约定，并使 Task 所拥有的存活 child 数量受并发工作量限制，而不是随历史会话数量增长。

用户界面适配器打开 child 会话时，只读取持久化 transcript，不会仅为展示而恢复 agent。用户输入通过继续执行管理器，启动或加入与 parent 输入相同的 Task 激活。由用户启动的 Task 会保留当前加载的精确 parent Agent 作为通知目标，`job_output` 仍是唯一结果路径。只要 Task 尚未标记为已报告，现有完成监听器最多注入一条主动通知；`kill`、终态读取或终态等待都可能将其标记为已报告，并抑制这条通知。因此，仅允许在该 parent 实例保持存活时进行用户交互。可以比 parent 存活更久、并将结论显式合并回去的用户自有会话属于[交互式 side session](../../proposed/feature/2026-07-08-interactive-side-sessions.zh.md)，不属于这一由 Task 持有的生命周期。

如果没有附加任务控制器，`JobRegistry.start()` 会拒绝 producer。因此，接受 child 输入的用户界面适配器必须附加任务控制器，或运行于加载了 `@deepseek-ai/dsh-tool-jobs` 的部署中；仅加载 Task 服务并不足够。这项依赖是 parent 和用户启动的激活共用 Task 结果、取消和通知路径所付出的代价。

取消始终作用于当前完整激活。如果用户消息和 parent 消息已经加入同一个轮次，任一调用方发起取消都会中止该轮次、dispose 其 run，并将对应 Task 结算为 `killed`；这些消息没有独立的结果或取消权。`followup()` 要求调用方提供信号；若在线 steering 正在等待请求准入时该信号被中止，激活自有的 controller 会被中止，以便提供方丢弃待处理消息，并且该调用仅在子 agent 完全停稳后结算。若需要独立取消，后续消息必须另起轮次，而不能加入当前轮次。

从持久化存储恢复的 Task 会在查找描述符或等待任何提供方操作之前，创建由本次激活持有的 `AbortController`；描述符查找、直接 parent 鉴权和描述符归并都在该 Task producer 内部执行，因此同一信号覆盖它们，其失败会将该 Task 结算为 `failed`。对于不接受信号的持久化调用，可以让底层 I/O 执行完毕；但继续执行管理器必须在每次这类 await 返回后重新检查取消状态，如已取消，之后不得开始或发布任何 child 工作。在 Agent 发布前收到中止信号时，提供方必须先回滚其创建事务并达到完全停稳状态，然后才让恢复调用以拒绝结束。Agent 发布后，提供方必须消除创建期间移交取消信号时的竞态，在返回前将同一信号附加到存活 run；之后取消会停止 child 轮次。即使提供方的恢复调用尚未返回 `SubagentRun`，`job_kill` 与对确切 owner 实例的 dispose 仍通过这条路径生效。Task 结算会等待回滚或 run dispose 完成，只有在激活完全停稳后才记录 `killed`。

### 活跃 run 关联

继续执行管理器在进程内维护 child session id 到当前 Task 的关联，并在提供方发布后将 run 填入该关联。它会在等待提供方 start 或 resume 之前安装 Task 关联，填入返回的 run，并且只在 run dispose 完成且 Task 终态发布后才移除该关联。该关联只用于让 parent 发送方和用户发送方找到同一次激活；它不是持久化 child 目录、公开的 `ManagedSubagent`、准入预留或 run 状态机。

对于可继续 child 的初始激活，继续执行管理器会在创建 Task 前分配稳定的 child session id，并将其作为 `SubagentProviderStartRequest.continuation` 传递；进程内 spawn 和 fork 会发布这一确切 id，而不是在内部另行分配。普通 `SubagentStartRequest` 不含 continuation 字段。后台工具返回规范的 `{ kind: 'background', jobId, subagentId }`，渲染为 `started subagent <childId> as job <jobId>`。child id 在多次激活中始终指代同一个持久化对话，Job id 则只指代当前激活。初始 Task 失败，或进程在 child 首次 flush 之前退出，都可能留下一个 **unmaterialized child**：调用方持有 child id，但不存在持久化 header 和描述符。后续按 id 的操作会报告该 id 不可用（已启动的 Task 会带着该详情失败），持久化枚举也不会列出它。

每个可继续 child 轮次都通过这条由 Task 支撑的路径准入。非终态 Task 是唯一受支持的存活激活；不存在激活时，其 run 已被 dispose，持久化 child 可以恢复。在路由任何按 id 的操作之前，继续执行管理器会同步将自身关联与 `ctx.agents.get(childId)` 比较。如果注册表中的 Agent 没有关联，或者它与所关联的 `run.localAgent` 不同，就属于所有权冲突：管理器会失败，而不会接管 idle Agent 或附加未受跟踪的轮次。二者均不存在时，可以从持久化存储恢复；如果检查后又有竞争方发布，仍会在 Agent 注册表的冲突边界上失败。

系统依据 Task 关联进行路由。运行中的 Task 通过 run 可选且提供确认语义的 `SubagentRun.steer` 功能接收在线消息。Task 不存在时，系统创建新 Task，并从持久化存储恢复 child。进程内 spawn 和 fork 会先同步要求 child 处于 `running` 状态，并拒绝已经提交结构化捕获的 child；随后调用 `Agent.steer()`，等待该消息专属的准入回执。默认循环会为每个 steering 项目提供一份归属于该消息的回执；只有在 `agent/step` 与异步提示词组装成功后，系统追加该消息、捕获不可变的请求历史并提交 `step/start`，回执才会解析为 `admitted`。终止型轮次策略、取消和 dispose（资源释放）会将待处理回执解析为 `rejected`。非终止型轮次关闭可以把待处理 steering 带入后续排队轮次，但不会确认其准入。提供方必须在调用 `Agent.steer()` 前检查存活状态，避免其 idle 路径在观察到的 run 之外启动轮次。如果查找关联之后、请求获准之前，Task 结算或终止策略率先完成，`steer()` 会拒绝，`send_message` 会报告消息未送达，而且该次调用不会改用从持久化存储恢复路径；在 Task 终态发布后重试，才可能启动下一次激活。

继续执行管理器不会串行化两个通过其外部路径同时争抢已停止 child 的调用方，也不会为结果产生与 dispose 之间的阶段单独建立 settling 状态。在 producer 首次 await 之前同步安装的关联，使本进程内每个 child 只准入一次激活——resume 加载期间竞争的 `followup` 会观察到待处理的激活并显式失败——而绕开该关联的发布仍会在 Agent 注册表相同会话的冲突边界上失败。发送也可能因与启动、取消、完成或清理发生竞态而失败。这些限制是明确的，而非隐藏在更大的生命周期抽象之后。

### 面向模型的 `send_message`

模型获得一个由 `SubagentRuntime.sendMessage()` 支撑的全局 `send_message(agent_id, message)` 工具。确切在线 sender 只能指定其直接 parent 或直接可继续 child；服务负责相邻关系检查、冷恢复、固定 Steer 调度，以及持久化 `{ kind: 'agent-message', senderSessionId }` 来源信息。取消只负责 inbox 接受前的工作。用户适配器保持分离，因为浏览器编写的输入携带用户来源信息与请求身份，而不是 Agent 权限。该工具位于单独加载的 `@deepseek-ai/dsh-tool-subagent-control` 包中，因此按提供方绑定的 `@deepseek-ai/dsh-tool-subagent` 实例可以继续为 spawn、fork 或 ACP 注册不同的委派工具，而不会重复注册全局控制工具。

- 如果 child 存在运行中的 Task 并支持在线消息，服务会调用 `run.steer(message, source)` 并返回现有 job id；它不会创建新 Task。
- 如果 child 没有运行中的 Task，`send_message` 会创建新 Task，使用该消息从持久化存储恢复会话，并返回新的 job id。
- 如果活跃提供方无法接收在线消息、带确认语义的 steering 在准入竞态中失败，或 Task 关联之外存在存活 child，`send_message` 会失败，而不会静默启动、恢复或接管未受跟踪的轮次。

服务结果将路由标识为 `steered` 并携带现有 job id，或标识为 `started` 并携带新的 job id。失败结果会明确说明消息未送达。面向模型的工具会呈现这些差异，让调用方能够观察由时序决定的实际路由。

发送到现有 run 的消息没有独立结果，其效果体现在当前 Task 的最终结果中。启动的后续轮次具有新 Task 的结果，并使用现有 `job_output` 读取路径。subagent 层不会再注入第二份完成通知。

用户输入使用同一个 `followup` 操作。UI 可以展示 child transcript 和当前 Task 状态，取消操作则以已加载 parent 作为调用方访问 Task 服务。工具 schema 与 UI 适配器消费同一个服务约定，不建立彼此独立的执行路径。

### 持久化 child handle 与从持久化存储恢复

继续执行管理器在创建 Task 前，通过 seam 的 `snapshotSubagentDescriptor()`（基于 [`snapshotJsonValue`](../../../../packages/util/values/src/index.ts) 构建）对每项描述符输入建立快照；这一边界与 Agent 消息现有的分离式无损 JSON 边界一致。作用于 child 作用域的 setup contribution——由进程内驱动前置安装的一次性 `agent/prompt-submit` 监听器——会在下游 prompt admission 能够阻止请求或抛出异常之前追加一个对模型隐藏的 `subagent/descriptor` 事件。admission 获准后才会开启 child 的初始轮次；admission 被拒绝时，描述符会作为轮次前的仅日志事实保留，并由该 activation 最终的必需检查点持久化。该事件不携带 `surfaceOp`，不进入模型历史，并在压缩替换 surface 历史时继续保留。只有在加载已知 child id 对应的 child 会话后，能在该 child 自身的后缀中（`seedLength` 之后，因此 fork seed 不会泄露祖先的描述符）得到受支持的描述符，且会话 header 将调用方标识为直接 parent 时，该 id 才可恢复。

版本化描述符的可继续分支（[descriptor.ts](../../../../packages/subagent/subagent/src/descriptor.ts) 中的 `SUBAGENT_DESCRIPTOR_VERSION`）携带 `mode: 'continuable'`、subagent 提供方名称、已解析的 child `agentOptions.provider` 和 `agentOptions.model`，以及可选的 `persona` 与 `toolFilter`。它不会对可通过声明合并扩展的 `AgentOptions` 对象建立快照：与此无关的扩展值不会仅因无法表示为 JSON 而导致继续执行失败。描述符会特意省略 `subagentDepth`；从持久化存储恢复时，系统依赖持久化 header 中的 `delegationDepth`，而不根据描述符重建深度。`outputSchema` 属于单次激活的结果约定，不属于持久化 child 组合配置。child header 仍是 child id、`cwd`、`parentSession`、`seedLength` 和 `delegationDepth` 的权威信息，持久化 child transcript 则负责保存 fork seed 和后续历史。[`delegationDepthOf()`](../../../../packages/subagent/subagent/src/index.ts) 会在 header 值和运行时值中取最大值，因此重建后的运行时选项可以加深持久化值，但绝不能降低它，恢复后的 child 无法重新获得顶层委派预算。

从持久化存储恢复不能依赖 `SubagentRun` 的可选方法，因为该 run 已被 dispose，并且进程重启后不会保留。run 表示一次可 dispose 的激活，只暴露作用于当前激活的操作。`SubagentRun.steer?()` 这一名称明确指代提供确认语义且仅适用于在线消息的功能，以免该功能与服务编排或面向模型的工具混淆。

内部继续执行管理器的恢复路径会加载已知 child 会话、归并其描述符、根据持久化的 `parentSession` 鉴权，并在其创建的 Task 内部运行。它通过私有服务闭包传递完全解析的 `SubagentProviderResumeRequest`，其中包含由 Task 持有的取消信号；该闭包只负责在检查提供方功能后进行分发，并执行 `start` 所使用的普通 run 生命周期观察。选中的 `SubagentProvider.resume?()` 负责传输相关的重建（进程内：在当前加载的 parent 作用域下执行 `parent.ctx.agents.resume`），并返回一个新 run。提供方是否存在该方法本身就是继续执行功能，无需额外功能标志。`SubagentRuntime.followup()` 在关联 run 的 `steer?()` 操作与该持久化恢复路径之间做出选择。私有的提供方分发与提供方本身都不会枚举持久化 child 或关联 Task。

后台工具会在调用 `JobRegistry.start()` 前校验描述符输入并建立快照。同步校验失败会拒绝工具调用，且不会创建 Task。除此之外，工具会立即返回 child id 和 Job id，不等待 child 发布或描述符持久化完成。进程内可继续提供方会在 child 进入 idle 后、读取结果之前执行最终的 `SessionStore.flush()`；返回 `true` 表示至少有一个持久性监听器参与，返回 `false` 表示必需的检查点失败，而拒绝则携带监听器失败。此操作会在 child 仍存活时重试循环中失败的检查点。如果最终确认失败，提供方会拒绝而不返回未经确认的输出，继续执行管理器会 dispose 该 run，已经创建的 Task 会结算为 `failed`，其详情包含持久性诊断。最终确认期间发生取消时，尚未发布的激活结果由取消操作接管；即使 child 轮次已记录为完成，或之后的检查点失败，也不能取代 Task 的 `killed` 结果。前台一次性运行仍保留循环仅尽力执行检查点的行为。进程内 spawn 和 fork 会在当前已加载的 parent 作用域下重建组合配置。恢复 fork 时只加载 child 自己的持久化 transcript，其中已经包含初始创建时捕获的已完成轮次前缀；系统绝不会再次 fork parent 更新后的历史。恢复 parent 不会立即恢复其 child。

TODO（ACP 继续执行）：将远端 ACP session id 作为提供方专用描述符数据持久化，并实现 `AcpProvider.resume?()`，依次执行 spawn、initialize、`loadSession` 和 prompt。初始 ACP run 必须检查 `initialize.agentCapabilities.loadSession`，恢复后的每个进程必须使用同一个持久化后端；`loadSession` 回放的历史消息不得计入新激活的输出。由于 ACP 的加载支持是按 child 协商的，不能仅根据提供方是否存在该方法来确定，因此该后续工作还必须定义 start 结果如何声明单个 child 支持继续执行，之后才能将 ACP child 写入持久化目录。

### 结果与通知所有权

每次可继续 child 激活都恰好拥有一个 Task 和一个 `JobOutcome`，无论第一条消息由 parent 还是用户提供。只要 Task 尚未标记为已报告，通用 Task 报告约定最多会向保留的 parent owner 注入一条主动完成通知；读取、等待和取消都可能抑制该通知。发送到运行中激活的消息会加入该激活，不会创建第二个 Task 或第二份结果。child transcript 是面向用户的详细记录；Task 输出是面向 parent 的最终结果。

Task 记录和活跃 run 关联都位于进程内。持久化使 child 会话可在重启后恢复，但不会恢复中断的 Task、其结果或通知。持久化 Task 恢复属于另一个问题。

## 已考虑的替代方案

**在 Task 结算后保留所有后台 child。** 这是 Codex 风格的常驻会话模型：发送后续消息成本较低，但历史 child 会持续占用 agent 作用域、会话内存、监听器和提供方资源，直至显式常驻数量上限或淘汰策略将其移除。逐激活 dispose 使用持久化作为继续执行边界，同时保留当前的资源上限。

**允许用户轮次不使用 Task。** parent 消息加入此类轮次后，没有对应的 Task 结果或完成通知；UI 取消对 parent 所发消息的影响也不明确。让每次激活都拥有一个 Task，可使完成与取消成为 child 轮次的属性，而不是初始调用方的属性。

**在 child 会话整个生命周期内复用一个 Task。** 终态 Task 无法自然地再次进入运行状态，一个结果也无法表示多个轮次。每次激活创建新 Task 可以保留通用 Task 约定。

**为每条消息创建 Task。** 发送到现有 run 的消息会加入已有轮次，不产生独立的最终结果；为这类消息创建 Task，会重复当前 Task，或报告一个它并不拥有的结果。只有启动新激活的消息才会创建 Task。

**拆分 `send_message` 与 `follow_up`。** 两个独立的投递操作会向模型暴露实现状态差异，却无法消除 child 已停止时的竞态。单一操作采用 Claude Code 模型：向运行中的工作发送消息，或恢复一个由新 Task 支撑的生命周期。

**在已 dispose 的 run 上保留 `resume?()`。** 如果仅为调用 `resume()` 而保留已 dispose 的 `SubagentRun`，旧 run 会同时充当持久化 child handle，而且进程重启后无法重建该对象。由服务分发、提供方重建，可明确表达持久化边界。

**将控制编排放在 `SubagentRuntime` 上。** 这一服务放置方案即[服务合并决策](../simplification/2026-07-26-merge-subagent-control-service.zh.md)；[意图操作细化](../simplification/2026-07-27-intent-named-subagent-continuation-operations.zh.md)将提供方 start／resume 分发的复用限制在服务内部，同时将可选的 Task 与持久化工作隔离在注入的内部管理器中。

**增加显式激活阶段。** 公开的 `starting`／`running`／`settling` 状态可以准确描述准入和清理，但会引入实现本身并不需要的生命周期协议。同步安装关联无需暴露这些阶段，即可消除进程内重复的 cold resume。

## 测试

- `packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` 固定可继续执行的持久性边界：缺少 flush 监听器、flush 监听器已脱离或监听器持续失败时，均会以 `DURABILITY_FAILED` 拒绝；循环检查点的瞬时失败可在最终确认成功后继续完成，发生取消时最终检查点无论成功还是失败都由取消优先决定结果，resume 同样会确认持久性，而前台运行仍采用尽力而为策略。`packages/subagent/subagent/tests/continuation.spec.ts` 以无密钥方式驱动真实栈（agent loop、JSONL 持久化、spawn／fork 提供方、Task 服务和 `ctx.subagents`）：初始及恢复后的激活都会创建新 Task，并在进入终态前 dispose 各自的 run；描述符事件位于轮次前、对模型隐藏、带版本、在服务分配的 child id 下持久化，并在初始 prompt admission 阻止请求或抛出异常时仍保留；取消、steering、cold follow-up、授权、所有权冲突与 resume 竞态保留上述约定。
- `packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts` 固定 `send_message` 的 schema、coordinator 来源标记、两种路由渲染、未送达失败、无 agent 时的拒绝，以及 HMR（热模块替换）dispose。
- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 覆盖配置的后台路由：可继续模式要求提供方可恢复，并在不要求 `send_message` 的情况下返回两个 id；即使提供方可以恢复，一次性模式仍保持普通的 Task 确认消息；它还固定 Task 服务集成及面向模型的 Task 控制工具。
- 无密钥 SDK 快照场景 [`subagent-continuable`](../../../../snapshots/sdk/subagent-continuable/)固定模型可见的 transcript：双 id 确认消息、最终持久性确认失败（该失败通过 `job_output` 呈现，且不包含未经确认的 child 输出），以及一次 `send_message` 后续操作——其已启动的 Task 会带着「id 不可用」失败。

## 影响

- 每次完成结算后的后续轮次都需要承担持久化加载和作用域 setup 成本；作为交换，存活 child 的数量受并发工作量限制，而不是随历史会话数量增长。持久化不可用或存储的组合配置无法重建时，可继续 child 的创建会明确失败。
- 两个调用方仍可能通过继续执行管理器外部的路径争抢已停止的 child。Agent 注册表会阻止相同会话的重复发布；失败的 Task 会失败，且其消息不会送达。消息也可能与取消、终态状态发布或 run dispose 发生竞态。准入不承诺原子或恰好执行一次；在进程内同步安装的关联无需公开生命周期状态机，即可通过 `followup` 消除重复的 cold resume。
- 通过普通 Agent API 驱动可继续 child 会绕过其 Task 关联。`ctx.subagents` 会将该存活 child 视为所有权冲突并拒绝；适配器必须在不加载 Agent 的情况下展示持久化 transcript，并通过 `SubagentRuntime.followup()` 提交用户输入。
- 活跃 run 关联只能协调一个运行时。多个进程同时恢复时不会串行化；此类部署需要持久化层的租约或 compare-and-set 操作。
- 用户交互要求作为 owner 的那个精确 parent Agent 实例保持存活，因为 dispose owner 会取消并移除其 Task。用户交互还要求附加任务控制器。若要单独与 child 交互，后续必须将 Task 访问所有权与持久化通知目标分离。
- 后台工具会在 child 发布和描述符持久化之前返回 child id 和 Job id。启动失败、最终持久性确认失败，或进程在 child 首次 flush 之前退出，都会使 Task 失败，并可能留下 unmaterialized 或陈旧的 child id；按 id 的控制操作会将缺失状态报告为不可用，而不会追溯修改工具确认消息。
- 将显式组合字段持久化到 child 日志后，其无损 JSON 与兼容性约定便成为恢复约定的一部分。后续如需支持其他组合配置输入，必须明确更改描述符版本，不能隐式持久化可通过声明合并扩展的 `AgentOptions` 字段。
- Task 记录和活跃 run 关联位于进程内，而 child 会话具有持久性。重启会恢复会话，但不会恢复进行中的工作或其 Task 通知。
