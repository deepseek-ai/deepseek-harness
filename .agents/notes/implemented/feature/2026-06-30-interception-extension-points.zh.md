# Agent Note: 拦截扩展点——钩子编程所面对的类型化 Decision 接口

Status: implemented

[English](2026-06-30-interception-extension-points.md) | 中文

## 问题

harness 需要一套钩子子系统：用户像 Claude Code（CC）和 Codex 那样在生命周期节点扩展或管控 agent（智能体）。驱动本设计的关键视角转换是：**「原生钩子」不是一个包**——原生钩子只是一个普通的 Cordis 插件，订阅规范的生命周期事件。因此真正的产品是一个*强大、类型完备的规范事件接口*；CC/Codex 桥接（`dsh-hooks-claude-code` / `dsh-hooks-codex` 包）只是将外部 shell 钩子协议映射到同一接口的翻译层。桥接能做的事，普通插件可以直接做——而且更强大（无序列化边界、完整 `ctx`、类型化返回值）。

该接口需要为以下场景提供各自独立的约定：逐提示词策略（CC 的 `UserPromptSubmit`）、会话启动观测（CC 的 `SessionStart`）、工具执行前策略、环绕调度控制、工具执行后变换、最终结果观测，以及携带面向模型的原因的继续执行。如果把这些阶段混为一谈，插件就会获得不需要的 mutation 通道，而终结性将依赖监听器的注册顺序。[事件域语义 Agent Note](../architecture/2026-06-30-event-domain-semantics.zh.md) 提供了三域规则与类型化 Decision 惯用法；本 Agent Note 将其应用于生命周期扩展点。

## 决策

规范接口将可变换策略、环绕调度控制与仅观测通知分离。策略 waterfall（瀑布式事件）返回小型的、扩展点专属的**类型化 Decision 联合类型**；包装层返回规范化结果；通知接收不可变快照，无法影响结果。覆盖的钩子点包括 `session-start`、`prompt-submit`、`pre-tool`、`post-tool`、通过 continuation 实现的 `stop`，同时将非钩子的执行策略留作独立可组合。

**Agent 事件**（`dsh-agent`）：
- `agent/session-start({ agent, source })` ——emit，在第 1 轮次之前触发一次，携带 `SessionStartSource`（`startup` 表示全新/fork 创建，`resume` 表示重新加载的持久化会话；`clear`/`compact` 保留）。纯通知，不能阻塞启动（这是有意的空白：桥接可以记录/注入，但不管控启动）。监听器通过 `agent.inject()` 注入上下文。
- `agent/pre-step({ agent, messages, turn, step, signal }, next) → PreStepDecision` ——waterfall，在每个拟议步骤之前、循环原子移除其独占 inbox 批次后触发。payload 携带该请求的 `turn`、`step` 与取消 `signal`（已退役的 `PreStepContext` 字段位于 payload 中；参见 [payload-object 事件决策](../../archived/architecture/2026-08-06-agent-event-payload-objects.md)）；没有中途输入的工具续步会收到空批次。`enter` 返回完整消息批次，其中包括监听器为当前请求贡献的上下文；`reject` 不打开步骤，并让已领取消息保持已删除。

**`agent/turn-stopping`** 是自然停止边界上的一次 awaited 通知。需要再执行一步的监听器调用 `agent.steer()`，传入来源显式的 steering（中途引导）内容供模型使用；循环随后重新读取 outbox，继续执行或关闭轮次。

### 工具流水线为每个阶段赋予一种权限

每次调用遵循 `tools/pre-execute` → guards → `tools/execute` → dispatch → `tools/post-execute` → 由工具定义负责的 `finalizeContent` → `tools/result`。注册表对调用方输入创建快照、实体化并冻结参数、分配一个不透明 token，并在策略开始前对可见定义的最终内容回调创建快照。嵌套调用仅携带父 token。身份始终不可变；只有 `signal` 可在环绕调度时改变。日志、UI 和工具体因此对「执行了什么」达成一致。

- **`tools/pre-execute`** 是可扩展的 waterfall 门禁。其 `PreToolDecision` 允许、拒绝或询问。拒绝跳过 `tools/execute` 与核心调度。询问通过可选的审批 seam 解析：只有 `allowed-once` 继续通过 guards 和调度；拒绝、取消、通道不可用、审批服务缺失或无 agent 调用均规范化为拒绝。每个已解析的 decision 仍会到达后置策略；监听器抛出的异常会成为最终的规范化失败。
- **`ctx.tools.guard()`** 在整个 pre-execute waterfall 之后安装同步的、作用域感知的策略。guard 可以拒绝或弃权，永远不能强制允许，因此监听器顺序无法复活一个被最终不变式禁止的操作。
- **`tools/execute`** 是用于超时、重试和指标插件的环绕调度 waterfall。包装层通过 `next()` 委托给核心调度，在此之前可以替换并恢复必需的 `exec.signal`，但不能移除它；包装层接收抛出异常或未知工具产生的、已完成规范化的规范成功／失败结果。包装层自行产生的成功结果会短路调度，并通过已解析的输出声明重新规范化。
- **`tools/post-execute`** 是检查／变换 waterfall。其 `PostToolDecision` 接受、以反馈阻止、替换呈现内容或规范值，或附加 `additionalContexts`。替换值会重新校验并重新计算呈现；替换内容会保留程序化值，且不构成保密边界。返回的 decision 是受支持的变换通道。
- **`ToolDefinition.finalizeContent`** 是一个可选、同步、对所有输入都有定义且仅能处理内容的边界，在调用创建时随可见定义一起被快照。注册表将候选结果规范化并创建无损快照后，它恰好运行一次；候选结果包括绕过后续 waterfall 的 pre、around 或 post 监听器失败，以及为另一个结果字段创建快照时发现的错误。它可以替换 `content`，也可返回 `undefined` 保留原内容，但不能重写 `isError`、结构化错误身份、上下文或呈现元数据。工具在此执行自身最后一道内容不变式，而无需将策略失败转换为更弱的阻止 decision。
- **`tools/result`** 是在所有变换、无损 JSON 实体化和外层错误边界之后的同步且故障受控的通知。它接收相同的冻结执行身份和权威结果的不可变快照；观测者的失败按监听器隔离，无法改变或拒绝 `ToolRuntime.execute()` 返回的结果。

核心调度与工具体位于规范化边界内部，因此工具、监听器、无效规范值、渲染器／投影器、非 JSON 呈现和身份形状错误均解析为 JSON 安全的 `isError` 结果，而非逃逸出轮次。post-execute 监听器因此可以检查一个抛出异常的工具；由工具定义负责的最终内容不变式也会覆盖外层流水线与候选结果实体化失败；最终观测者会同时看到执行期间的规范值，以及会话日志能够持久化的确切呈现字段。[规范工具输出约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)定义值／投影与持久性规则。

### 三个承重的循环决策

1. **在每个拟议步骤运行 pre-step 策略。** 循环会在首次领取和决策之前打开轮次，因此 reject 会关闭一个持久、blocked 且不含步骤或模型可见消息的轮次。即使工具续步没有新取得所有权的输入，也会提交空批次，使逐请求上下文生产方可以把带日志的消息加入这一次请求。enter 时，循环先开启步骤，再把返回批次作为 `user/message` 追加，然后派生请求。依照[一次 send 对应一个轮次的简化](../simplification/2026-07-17-one-send-one-turn.zh.md)，每个已领取 follow-up 仍是其轮次中唯一的直接提示词。

2. **工具执行后的 `additionalContexts` 与异步注入进入活跃批次 FIFO，并在该批次结算时追加。** `content`/`feedback` 塑造 `execute()` 返回的结果，但每项上下文都是一条独立的带来源 `user/message`，而单个步骤或组合工具可以产生许多上下文。立即追加上下文会产生 `result(c1) → context → result(c2)` 的交错，或把嵌套上下文放在外层结果之前，破坏工具调用／工具结果邻接性。因此 `ToolRunContext.deferContext()` 会在失败路径上也收集嵌套调度上下文，`execute()` 在 `ToolExecutionResult` 上暴露有序数组，循环再把它接纳到与执行期间 `agent.inject()` 调用相同的 FIFO 中。FIFO 在批次结算时，在所有已记录结果之后追加，其中也包括被中断轮次关闭之前。被接受的外层调用将 deferred contexts 保留在 decision contexts 之前；被外层阻止时则丢弃 deferred contexts，只暴露阻止 decision 显式提供的上下文。

3. **stopping 监听器通过 steering 通道请求继续执行**，使得下一步骤在循环顶部排空时将其记录为当前轮次的 steering——同一轮次内的下一*步骤* steering，而非下一*轮次*的提示词。

### 工具执行前输入重写是一个独立的一致性决策

`PreToolDecision` 不能重写参数。历史和审计调用在执行前记录，UI 展示读取相同的输入，因此注册表在策略之前封存参数。有效的重写必须在身份创建之前同时更新历史、审计、展示和执行；该约定属于[输入重写提案](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)。

### 边界

Service Definition 包**不**声明 `hook/*` 会话事件（持久的钩子调用日志）；那些属于 `dsh-hook-protocol`，因为原生插件使用类型化 decision 而无需外部钩子日志。原生插件集成测试（`packages/core/agent-loop/tests/interception.spec.ts`）通过真实循环组合这些扩展点，不涉及 `hook/*` 协议。压缩（compaction）（`PreCompact`/`PostCompact`）、Notification 和 Codex `PermissionRequest` 不在本决策范围内。[审批 seam](2026-07-06-approval-seam.zh.md) 通过 `ctx.approval` 解析 `ask` decision；终结性的单调停止由工具结果数据表达，而 `agent/turn-stopping` 是引导再执行一步的最后机会。

## 曾考虑的替代方案

- **将工具执行前输入重写作为本扩展点集合的一部分发布**：推迟，视为越界信号；上文已阐述一致性问题（审计、历史和展示都读取执行前记录的 `tool/call.arguments`），[工具执行前输入重写提案](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)负责该设计。
- **将持久的 `hook/*` SessionEvents 与扩展点一起声明**：否决。原生插件使用类型化 Decision 而完全不需要钩子日志（实际示例已证明），因此持久日志属于[钩子协议库](../../../../packages/hooks/hook-protocol/README.zh.md)，而非扩展接口。

## 后果

规范拦截接口具有统一的类型化，同时不给每个扩展相同的权力：钩子返回 decision，执行包装层做包装，终结 guard 只能拒绝，最终观测者只能观测。循环负责 session-start、pre-step 领取结算、工具执行后上下文缓冲和 stopping；`dsh-tools` 负责身份封存与五阶段执行流水线。它们的约定记录在 [architecture.md](../../../../docs/architecture.zh.md)、各包 README、[核心拦截 decision](../../../../docs/subsystems/core.zh.md#interception-decisions) 与[工具结构](../../../../docs/subsystems/tools.zh.md)中。ACP 桥接会把 blocked 无步骤轮次中的首次 pre-step reject 结算为 `end_turn`，而钩子驱动的快照端到端验证可观测的桥接行为。
