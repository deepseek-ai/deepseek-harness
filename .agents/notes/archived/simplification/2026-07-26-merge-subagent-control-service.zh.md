# Agent Note: 将 subagent 控制合并到 subagent 服务

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-merge-subagent-control-service.md) | 中文

公开操作集合由[以意图命名的 subagent 继续执行操作](2026-07-27-intent-named-subagent-continuation-operations.zh.md)进一步细化，并由[可继续的 subagent](../feature/2026-07-28-continuable-subagent-conversations.zh.md)再次细化——后者保留这一个合并后的服务，同时移除提供方 `resume` 派发和基于 Task 的继续执行生命周期。

## 问题

可继续 child 的编排最初位于原始 `ctx.subagents` 提供方约定之上的独立 `ctx.subagentControl` 服务中。该拆分使提供方分发与 Task 和持久化无关，并为模型适配器与面向人类的适配器提供统一的编排约定。实践中，两个服务属于同一组能力，每个可继续调用方都需要二者，而绑定提供方的委派工具必须根据 `provider.resume` 推断策略，并检查控制服务与 `send_message` 工具是否碰巧已加载。如此一来，配套插件是否存在会决定执行语义，并将可继续工作的启动耦合到可选的后续操作接口。

## 决策

`SubagentRuntime` 是唯一的公开服务。它公开普通的 `start(name, request)`、由 Task 支撑的 `startContinuable(spec)`，以及按意图命名的 `followup(...)`；提供方的 resume 分发仍封装在其继续执行管理器内部。独立的 `@deepseek-ai/dsh-subagent-control` 包和 `ctx.subagentControl` 键均不存在；可选的 `@deepseek-ai/dsh-tool-subagent-control` 包则直接注入 `ctx.subagents`。

合并后的服务及其提供方公开一套 `SubagentError` 分类体系。稳定错误码把提供方查找失败和能力相关失败，与继续执行路由、鉴权、取消、持久化和送达失败区分开来；已移除的服务不保留单独的错误类。

继续执行的实现仍是内部管理器，不会扩展提供方注册表的核心状态。`SubagentRuntime` 通过 `ctx.inject(['tasks', 'agents'], ...)` 创建该管理器，因此注入的 Cordis child fiber 拥有自身的 Task 完成监听器和拆卸 effect。加载提供方注册表不要求 Task 或持久化。只有 Task 和 Agent 可用时，该管理器才会存在；每项继续执行操作都在需要持久性时解析会话持久化服务。dispose（资源释放）该 fiber 会先取消并结算活跃的继续执行，再释放其关联。

`startContinuable` 与底层 `start` 保持分离，因为二者的所有权与时序约定不同：前者分配持久化 child id、创建 Task，并同步返回两个 id，而启动过程继续在 Task 内运行；底层 `start` 则等待提供方发布，并移交一个由持有方负责的 run。若通过标志或返回值联合类型将该方法并入 `start`，会扩大底层约定，改动反而多于保留现有的显式入口。

每个 `@deepseek-ai/dsh-tool-subagent` 实例都会选择 `backgroundMode: 'one-shot' | 'continuable'`，默认值为 `one-shot`。这项配置表示策略；`provider.resume` 只用于检查所配置的可继续模式是否受提供方支持。因此，可恢复的提供方仍可执行一次性后台工作。`send_message` 工具是独立适配器：加载或省略该工具既不会启用也不会禁用 `startContinuable`。

## 已考虑的替代方案

**保留独立服务。** 这样能保持最严格的依赖分离，但每条生产环境中的可继续路径都要组合两个服务，而额外的公开键会暴露调用方并不需要的架构差异。内部管理器无需第二个服务，也能保留可选的 Task 和持久化依赖。

**根据 `provider.resume` 推断可继续模式。** 方法是否存在可以准确表示从持久化存储恢复的能力，却不能表示部署策略。这会迫使每个可恢复的提供方都采用可继续后台语义，并使配套插件缺失成为运行时错误。显式的工具配置将选择与能力分离。

**注册继续执行访问入口，或检查后续操作工具。** 注册表可以告诉委派工具继续执行接口是否存在，但启动具备持久性的工作不需要任何后续操作适配器。这样的注册表会把 UI 组合编码进执行策略，并以另一个名称重新建立插件间依赖关系。

**将底层启动与可继续启动合并为一个方法。** `start` 上的标志会使该方法返回已发布的一次性 run，或立即返回 Task 和 child 标识，从而削弱简单的所有权边界。保留 `startContinuable` 改动更小，也能明确保留两项约定。

## 影响

- 服务拓扑少了一个公开键和一个包，同时底层提供方分发仍可在没有 Task 或持久化时使用。
- 配置的提供方缺少 `resume` 时，可继续模式会在提供方挂载阶段失败；缺少 Task、Agent 或持久化时，仍会在需要它们的最早操作处失败。
- 后续消息投递仍为可选功能。部署可以通过 Task 工具启动并收集可继续工作，而不公开 `send_message`。
- `dsh-subagent` 包内的继续执行管理器仍然感知 Task 和持久化，因此该包会将这些服务声明为可选的对等依赖（peer dependency），即使普通的 `start` 调用方并不需要它们。
- 现有的继续执行竞态、授权、持久性、取消及先结算再 dispose 的语义均保持不变，并继续由迁移后的 `subagent` 测试固定。
