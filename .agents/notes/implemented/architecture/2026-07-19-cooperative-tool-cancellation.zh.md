# Agent Note: 注册表边界上的协作式工具取消

Status: implemented

[English](2026-07-19-cooperative-tool-cancellation.md) | 中文

## 问题

每次类型化工具调用都需要一个由调用方持有的取消信号。可选的 `ToolExecutionInput.signal` 允许直接调用方不承担所有权，使每个工具主体中的 `exec.signal` 都成为可选值，也会诱使注册表提供无法表达真实调用方生命周期的后备信号。

流水线各阶段对可变性的需求也不同。工具实现、前置策略、后置策略和结果观察者只借用取消状态，而环绕调度包装层必须临时替换信号，以加入截止时间或其他词法取消作用域。单一的可变公开类型要么把修改权限授予过多阶段，要么阻止这种组合。

取消可能发生在策略之前、审批期间、环绕调度等待期间、工具主体启动之后，或后置策略等待期间。单一的 `ABORTED` 结果无法让持久化结果的消费方判断工具主体是否可能产生过副作用。让工具 promise 与取消竞速也不是安全的后备方案，因为注册表报告完成后，被丢弃的同进程工作仍会继续运行。

## 决策

`ToolExecutionInput.signal` 是必填且只读的 `AbortSignal`，因此 `ToolExecution.signal` 和 `ToolRunContext.signal` 也都是必填且只读。每个类型化调用方显式提供自己持有的信号；注册表不提供重载、默认控制器、永不中止哨兵或便捷执行路径。

`ToolDefinition.execute(args, exec)` 保持现有签名。`defineTool()` 会把 `exec.signal` 上下文推断为必填的 `AbortSignal`，因此每个已注册的 TypeScript 工具都能在无需类型断言的情况下观察或转发取消。所有第一方直接调用方和 PTC mode 嵌套调度都会显式传入当前操作的信号。

注册表信任这份类型化同进程约定。它不在运行时校验 `AbortSignal`，也不为缺失或畸形信号添加敌意输入测试。校验仍位于解析器与配置、模型与工具 JSON、持久化与文件、worker、进程和协议边界；违反 TypeScript 接口的无类型 JavaScript 不享有兼容性约定。

### 可变性由流水线阶段决定

`ToolDispatchExecution` 与 `ToolExecution` 相同，唯一差异是其必填 `signal` 可修改。只有 `tools/execute` waterfall（瀑布式事件）接收这个类型。前置策略、后置策略、结果观察者、守卫和工具实现接收注册表私有可变运行对象的只读视图。

环绕调度包装层可以在委托期间替换 `exec.signal`，但无法通过类型系统删除它或赋值为 `undefined`。注册表在可变对象之外捕获必填的调用方信号，在工具主体调用前把每次包装层替换与调用方信号融合，在完成后移除仅属于本次调度的监听器，并无条件恢复必填的上游信号。

### 取消代码记录是否发生过调度

`dsh-tools` 导出 `TOOL_ABORTED = 'ABORTED'` 和 `TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`。注册表在调用 `ToolDefinition.execute()` 的前一刻记录工具主体已调用。

`ABORTED_BEFORE_DISPATCH` 携带 `{ name: 'AbortError' }` 和模型可见文本 `Error: tool call aborted before dispatch`。凡取消阻止工具主体调用时都使用该结果，包括进入时已中止、前置策略或审批期间取消、包装层信号已中止、包装层在委托前返回的成功结果被调用方取消抢先，以及轮次取消后 agent loop（智能体循环）跳过的同批调用。

`ABORTED` 携带模型可见文本 `Error: tool call aborted`，并且只在工具主体已经调用后使用，包括工具主体完成后环绕包装层或后置策略监听器等待期间发生的取消。拒绝、包装层失败、工具失败或后置策略失败比通用取消更具体。timeout-policy 自身拥有的超时仍为 `TOOL_TIMEOUT`，成功结果被取消替换前延后附加的上下文仍会保留。

### 进入时已中止会在物化后短路

注册表先创建调用 token，对可见工具定义的可选 `finalizeContent` callback 做快照，并对参数进行无损快照和冻结。即使调用方信号已经中止，参数物化失败仍优先返回。在最终内容处理之前，注册表还会对候选结果进行无损快照，并把结果快照失败转换为普通错误，从而使该 callback 仍能保证其内容不变量成立。参数物化成功后，进入时已中止的信号会跳过 `tools/pre-execute`、审批、`tools/execute`、`tools/post-execute` 和工具主体，然后先由该仅处理内容的 callback 处理 `ABORTED_BEFORE_DISPATCH`，再发布且只发布一次冻结的权威 `tools/result`。

### 已启动工作仍必须完全停稳

工具主体一旦启动，注册表就会等待它完成。取消通过融合信号到达工具主体，但注册表不会与其 promise 竞速或丢弃该 promise。协作式实现会停止自身工作或继续转发取消，并在所持有的工作完全停稳后完成；不协作的同进程实现可能让注册表无限期保持等待。进程、worker、网络和提供方层仍负责各自的终止机制。

这项决策只要求工具调用边界携带取消信号。让工具主体可达的异步能力也必须接收信号，属于另一项迁移，见提议中的[工具可达能力 seam 中的必填取消](../../proposed/architecture/2026-07-19-required-cancellation-through-tool-capability-seams.zh.md)。

## 验证

[`execution-signal-types.spec.ts`](../../../../packages/core/tools/tests/execution-signal-types.spec.ts) 证明必填的精确信号类型、观察者与工具的只读视图、环绕调度可替换但不可删除的视图，以及 `defineTool()` 推断。[`tools.spec.ts`](../../../../packages/core/tools/tests/tools.spec.ts) 覆盖进入时已中止的物化与阶段跳过、策略和包装层竞态、工具主体调用分类、调用方信号融合、错误优先级、上下文保留和完全停稳。[`tool-calls.spec.ts`](../../../../packages/core/agent-loop/tests/tool-calls.spec.ts) 与 [`contract-regressions.spec.ts`](../../../../packages/core/agent-loop/tests/contract-regressions.spec.ts) 覆盖为未调度的同批调用补齐持久化结果。[`ptc.spec.ts`](../../../../packages/core/tools/tests/ptc.spec.ts) 和第一方集成测试覆盖显式转发，[`timeout-policy.spec.ts`](../../../../packages/guard/timeout-policy/tests/timeout-policy.spec.ts) 保持超时归属。

任何注册表测试都无法证明任意第三方同进程代码会观察信号或在有界时间内停止。各能力的测试仍需在拥有相应副作用的边界证明取消与完全停稳。

## 考虑过的替代方案

**保留可选信号并生成后备值。** 不予采纳，因为注册表持有的后备信号不代表任何调用方生命周期，也会保留类型系统本应阻止的缺失情况。

**在运行时校验 `AbortSignal`。** 不予采纳，因为这是类型化同进程边界，不是序列化边界。运行时检查只会重复静态约定，仍无法强制实现协作式使用信号。

**添加 `supportsCancellation` 元数据、回调参数数量检查或信号使用 lint。** 不予采纳，因为这些方法都无法证明异步工作会观察或正确转发取消。信号可用性属于类型约定；具体行为仍由工具和能力负责。

**向所有阶段公开同一个可变执行类型。** 不予采纳，因为观察者和工具实现只需要借用信号。按阶段划分类型可以把替换权限限制在流水线拥有该操作的位置。

**禁止环绕包装层替换信号。** 不予采纳，因为截止时间和嵌套操作作用域需要词法派生信号。捕获并融合调用方信号既保留组合能力，也不允许切断调用方取消。

**让工具 promise 与取消竞速。** 不予采纳，因为这种方式会在副作用仍可能存活时报告完成，违反[dispose（资源释放）必须完全停稳的规则](../../../../docs/defensive-patterns/general.zh.md#dispose-must-reach-quiescence-not-just-request-it)。

## 后果

- TypeScript 会拒绝所有缺少 `signal` 的 `ToolExecutionInput`、工具或观察者对只读信号的修改，以及环绕调度删除信号的尝试。
- 持久化结果的消费方可以区分工具主体可能产生过副作用的调用（`ABORTED`）和从未进入工具主体的调用（`ABORTED_BEFORE_DISPATCH`）。
- 根据仓库的预发布原则，这项变更刻意保持破坏性；不保留兼容重载或运行时后备行为。
- 协作式工具会及时停止并完全停稳；忽略信号的实现会表现为仍在等待的调用。
- 下游能力接口保持不变，直到关联的提议 Agent Note 被接受并实现。
