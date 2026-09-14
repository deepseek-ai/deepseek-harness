# Agent Note: 运行时边界显式携带 Agent 身份

Status: implemented

[English](2026-08-31-explicit-agent-runtime-identity.md) | 中文

## 问题

Agent 的 Cordis Context 拥有注册及其清理。Agent 身份则为某项操作选择会话、运行时所属方、事件主体、权限决策或协议身份。Context 上反向的 Agent 属性让这两个事实看起来可以互换：调用方选择用于管理 effect 所有权的 Context 时，可能意外地让该选择决定领域身份。

类型信息被擦除后，这项反向关联还需要补偿机制。Host Remote 转发会从已路由主体检查其 Context，创建流程会从调用方 Context 推断运行时父级，适配器则维护反向身份扫描。这些机制重复类型化请求中已有的身份，也掩盖了哪个调用方在运行时拥有 Agent。

若没有显式所属方，`SubagentContinuationManager` 会通过私有插件 Context 创建和恢复子级，因此基于 Context 的推断会把每个可续跑子级归类为 runtime root，尽管管理器持有其确切父级。仅限根级的消费方随后可能附加调度工具、授予直接人类输入对应的 Goal 权限，或像处理顶层 Agent 一样路由用户问题。

## 决策

运行时接口在拥有身份的位置携带 Agent 身份。`AgentSetup` 接收 `(agentCtx, agent)`；创建与恢复 Agent 的 options 通过 `parentAgent` 标识运行时子级；作用域事件在 payload 中携带 Agent；Remote 转发校验 `request.agent` 就是 carrier key；Host Typert Context 解析则把协议身份映射到存活 Agent Context，不执行反向扫描。`agent.ctx` 继续拥有注册和生命周期，不暴露反向 Agent 属性。

感知作用域的注册表继续仅使用不透明作用域键判断注册成员关系。tool-subagent 不会分类该键，也不会从 Context 解析 Agent。直接 `AgentSetup` 显式传入尚未发布的 Session，并在发布前通过所给 Context 完成安装。对于由设置控制的常驻 preset，事件 payload 提供 Agent，其 Session 提供策略目标，其 Context 拥有注册项。

`SubagentContinuationManager` 会把确切父级放进全新创建与冷恢复的 options。因此，存活的可续跑子级不会出现在 `AgentRegistry.roots()` 中，并且满足 `isOwnedBy(child.id, parent)`。持久化 `parentSession` 元数据不能代替这项关系：没有存活 Agent 拥有 fork 或已恢复会话时，它仍可成为 runtime root。

[Agent 注册作用域决策](2026-07-08-agent-scope-contexts.zh.md)、其[运行时设计](2026-07-12-agent-scope-runtime-design.zh.md)和[发起方作用域决策](2026-07-15-agent-initiator-scope.zh.md)继续拥有各自独立的注册、生命周期及私有调用链理由。本决策只取代其中描述的反向 Context 关联和隐式运行时所属方推导。

## 验证

Agent 创建测试锁定显式的根级与子级归属。continuation 集成测试让一个真实子级保持存活，直到断言其既不属于 `roots()`、又满足 `isOwnedBy()`。现有 Schedule 测试验证仅限根级的注册项不会出现在显式归属的子级中。

Remote 事件测试会在转发作用域 waterfall 前拒绝缺失或不匹配的 Agent。tool-subagent 测试验证 direct setup 会在 Session 发布前完成安装；常驻 preset 测试验证逐 Session 的策略读取与继承。

## 考虑过的替代方案

**保留 `Context.agent`。** 反向 accessor 会让注册所有权看起来等同于操作身份，还要求每个 Context 派生、适配器和测试替身保留一项与 Cordis 服务选择或 effect 清理无关的关联。

**从调用方 Context 推断运行时归属。** 私有管理器 Context、Agent Context 和常驻 preset Context 都能调用同一个工厂。因此，Context 祖先关系无法说明由哪个存活 Agent 拥有结果；创建方必须把它已知的父级放进请求 options。

**分类 Agent 作用域键。** 不透明作用域键表达路由成员关系，而不是领域身份。分类该键会让 Agent 成为组合中心，也仍会把插件的 effect 所有者与策略所需的 Session 耦合起来。

**使用发起 Agent 作为创建归属。** 发起方作用域记录异步执行的因果关系，而非生命周期归属。父级可能发起有意创建根级 Agent 的工作，而 setup 仍位于子级驱动边界之外。

**使用持久化会话谱系。** `parentSession` 跨进程生命周期记录对话祖先关系。运行时归属控制存活根级和 teardown，因此把二者等同会阻止合法恢复的 fork 成为顶层 Agent。

## 后果

生命周期 options、事件、服务请求和传输请求会携带显式 Agent 身份，因此每项操作都会声明自身使用的身份，TypeScript 也会检查两侧。Context 可以继续复用于依赖访问与 effect 所有权，而不会成为另一种领域对象定位器。

可续跑子级与一次性进程内子级使用同一种运行时父级关系。仅限根级的消费方会排除这些子级，父级 teardown 可以依据唯一的存活归属图推理，而持久化谱系仍可描述历史，不必承担进程内生命周期语义。
