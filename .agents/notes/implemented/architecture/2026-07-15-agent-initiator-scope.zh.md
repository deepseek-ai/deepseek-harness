# Agent Note: 基于 AsyncLocalStorage 的发起 Agent 作用域

Status: implemented

[English](2026-07-15-agent-initiator-scope.md) | 中文

## 问题

harness 中存在两种有用但不同的上下文概念。Cordis `Context` 负责选择服务、注册归属和生命周期；`agent.ctx` 是一个存活 Agent 所拥有的扁平注册作用域。Agent 与会话身份描述的则是异步操作主体。若提供表示「当前正在运行的 Agent」的动态 `ctx.agent`，就会混淆这两种含义，并在单进程并发驱动多个 Agent 时失效。

进程内深层基础设施有时需要在显式传递的循环、工具及请求参数之下获取可信的发起 Agent，例如宿主感知传输层、追踪辅助函数、日志器或网关客户端。要求每个私有辅助函数都转发 `agent` 会造成重复，而进程级可变槽会在跨 `await` 时发生并发错误。模型可见参数也不适用，因为模型不得选择可信的会话或路由请求头。该载体归 Agent 服务所有，而非模型可见的可选上下文。

## 决策

必需的 `ctx.agents` 服务使用 Node `AsyncLocalStorage` 携带发起 Agent。它直接存储同一个 `Agent`，不引入只有一个字段的帧；另一个私有运行标记只记录嵌套边界的谱系，供 teardown 记账使用，不携带身份。[核心数据目录](../../../../docs/subsystems/core.zh.md#initiating-agent)标明了所携带的类型。

`currentInitiator()` 用于可选读取，`requireInitiator()` 抛出 `no initiating agent is active`，`withInitiator(agent, operation)` 保留操作返回的同步值或 Promise 本身。`withoutInitiator(operation)` 会建立清空边界，供不得继承 Agent 的工作使用。会话仍通过 `agent.session` 推导；轮次、步骤、工具调用、`signal`、模型、`cwd`、沙箱和授权继续由现有归属方管理。

`AgentLoop` 已经注入 `ctx.agents`，并用 `agents.withInitiator(agent, ...)` 包裹每个具体驱动的完整 `runLoop` 生命周期。循环、轮次、步骤和工具调用的包内私有入口从 `ctx.agents` 恢复同一个 Agent，一次推导 `agent.session`，再由操作内辅助函数捕获该值，避免在浅层接口中转发具体驱动或 `Session`。若 `Session` 本身就是底层辅助函数的实际接口，该函数会保留狭窄的 `Session` 参数，而不会只为隐式查找而接收更宽泛的 `Context`。

因此，并发驱动使用彼此独立的存储。子驱动的异步延续携带子 Agent；`withInitiator()` 返回后，调用方立即恢复之前的存储，而活动运行计数仍持续跟踪返回的 Promise，直到其结束。创建、持久化加载和尚未发布的 `setup(agentCtx, childAgent)` 位于子驱动边界之外：由父 Agent 发起的创建使用父身份，而显式的 `childAgent` 参数标识子 Agent。

隐式身份不会取代显式约定。`ToolExecution.agent`、`AssembleContext.agent`、`AgentSetup` 的 Agent 参数、`GenerateOptions.sessionId`、任务归属、父子请求、审批与 hook 主体、`cwd` 选择、取消、worker 和进程消息、持久化记录及协议身份都保持显式传递。远程边界会把所需身份写入类型化请求，因为 ALS 只在进程内有效。

`AgentRegistry` 管理一个有序的发起方生命周期。teardown 会先拒绝新边界；移除 `ctx.agents` 后，AgentLoop 等注入方开始排空，注册表随后等待活动的返回 Promise 边界，最后调用 `AsyncLocalStorage.disable()`。如果某个边界继承的异步调用链启动所属 Cordis fiber 的卸载，私有运行标记谱系会从排空范围中释放该嵌套边界链，从而避免 teardown 等待自身完成，同时继续排空无关边界。在普通排空期间，进行中代码可通过保留的服务引用继续调用 `currentInitiator()` 和 `requireInitiator()`；dispose（资源释放）后，发起方方法会抛出 `agent initiator scope is disposed`。根 Context dispose 可能并发启动同级 fiber 的 teardown，因此除 Cordis 依赖顺序外仍必须统计活动边界。

发起方作用域不负责管理脱离返回链的工作：注册表排空只跟踪 `withInitiator()` 或 `withoutInitiator()` 返回的 Promise。边界内创建的异步资源会继承其存储，直到自身结束或 ALS 被禁用；所属 seam 必须显式停止未纳入返回 Promise 的工作。Agent 所属的前台工作会把完整生命周期纳入返回值，并保留显式取消约定。无关的定时器、队列和部署基础设施在 `withoutInitiator(operation)` 下启动；队列、worker、进程和协议边界必须序列化身份，不能期待 ALS 传播。

宿主感知的传输层可以从 `ctx.agents.requireInitiator().session.id` 推导由部署方拥有的 `X-Harness-Session-Id` 等请求头；模型可见 schema 和参数中不包含该请求头。本决策不让现有生产 MCP 或 Web 传输层采用此请求头。测试替身传输层用于证明可信边界，而不会把宿主路由策略分配给现有的提供方无关 seam。

本决策扩展 [Agent 注册作用域约定](2026-07-08-agent-scope-contexts.zh.md)及其[运行时设计](2026-07-12-agent-scope-runtime-design.zh.md)，不会改变其中 `agent.ctx` 的静态含义。[显式运行时身份决策](2026-08-31-explicit-agent-runtime-identity.zh.md)把发起方作用域限制在私有异步调用链内，同时让生命周期、归属、事件和协议接口直接携带各自的主体。

## 验证

Agent 服务测试锁定可选与必需读取、同步值及跨 realm Promise 的精确身份、内建 Promise 结束状态观察、并发、嵌套及清空边界、同步抛错或 Promise 拒绝后的恢复、普通与重入排空顺序及保留引用的错误。AgentLoop 集成测试锁定并发与嵌套驱动、无 Agent 调用、AgentRegistry 重启、根 Context 销毁，以及包内私有的循环和工具调度通过隐式查找完成。组合、模块图、构建及运行时闭包检查确保默认组合包、SDK 主干、Python 运行时闭包及直接 AgentLoop harness 通过 `ctx.agents` 完成接线，无需其他提供方。

测试替身形式的宿主感知传输层在内部推导 `X-Harness-Session-Id`，并验证工具 schema 与日志中记录的参数都不包含身份字段。服务有意不排空边界操作所返回 Promise 之外的异步工作；这类工作仍由所属方的显式停止约定管理。

## 考虑过的替代方案

**在每个函数中传递 Agent。** 公开、worker、进程、持久化和协议边界继续显式传递，但要求每个进程内私有辅助函数都携带 Agent 只会造成重复转发，不会提高可信度。ALS 仅限于这些显式边界内部的异步调用链。

**暴露动态的 `ctx.agent`。** Context 携带注册所有权，而非领域主体。为正在执行的 Agent 新增 accessor 会混合注册作用域与执行作用域，并让并发行为变得意外。

**新增独立的 `ctx.agentExecution` 服务。** 该载体没有独立后端、配置或身份类型：它存储的是 `ctx.agents` 已经管理的同一个 `Agent`，而 AgentLoop 本就依赖该服务。第二个必需提供方会增加包、组合、生命周期、生成目录及测试 harness 接线，却没有拆出真实能力。

**保存命名帧或完整运行时帧。** 只有一个字段的 `{ agent }` 帧只是包装该值，而 Agent、会话、inbox、取消、轮次、步骤、工具执行和持久化已经有各自的真源。增加更多字段会产生陈旧快照和另一套生命周期；直接携带 `Agent`，由方法名标识边界，无需重复保存状态。

**包含步骤级 `AbortSignal`、`cwd`、沙箱或授权。** 它们的生命周期及权限范围与驱动边界不一致，而且现有 seam 已经显式传递这些值。新增控制能力需要独立决策和嵌套生命周期约定。

**使用进程级 `currentAgent`。** 并发 Agent 和 subagent 会在异步延续执行之间相互覆盖，因此可变全局值只在 harness 不具备的串行保证下才正确。

**从模型可见参数推导身份。** 不能信任模型或用户输入来选择会话、租户或沙箱路由。

**给每个能力 seam 增加路由身份。** 这会把宿主关注点扩散到提供方无关 API。宿主感知实现拥有其传输请求头，而公开边界继续显式传递身份。

## 后果

深层基础设施可以获得一个可信的进程内发起 Agent，而无需加宽现有工具和能力请求。并发及嵌套驱动会自动隔离，AgentLoop 不增加新的必需服务，HMR（热模块替换）或根 Context dispose 会在禁用 ALS 前达到完全停稳。

该依赖不会出现在函数签名中，并且携带一个具有控制能力的 Agent 对象。消费方必须将其限制在横切基础设施中，把隐式存在视为既不证明存活、也不授予权限，并保留显式取消和归属检查。ALS 还有常驻传播成本，也无法跨越 worker、进程、HTTP 或持久化队列边界。

该销毁设计有意依赖 Node 的 [Stability 1（实验性）](https://nodejs.org/api/async_context.html#asynclocalstoragedisable) API `AsyncLocalStorage.disable()`。Node 要求在 ALS 实例可被垃圾回收前调用 `disable()`，这对 HMR 替换 AgentRegistry 所拥有的实例尤为重要；服务状态守卫会阻止 dispose 后通过后续边界重新进入该实例。

该作用域有意只携带 Agent，省略轮次、步骤、`signal`、`cwd`、沙箱和授权。若真实消费方无法使用现有显式字段，必须另行论证扩展；陈旧字段最多只能误标遥测数据，绝不能授予控制权。
