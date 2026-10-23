# Agent Note: 运行时边界显式携带 Agent 身份

Status: implemented

[English](2026-08-31-explicit-agent-runtime-identity.md) | 中文

## 问题

Agent 的 Cordis Context 拥有注册及其清理。Agent 身份则为某项操作选择会话、运行时所属方、事件主体、权限决策或协议身份。Context 上反向的 Agent 属性让这两个事实看起来可以互换：调用方选择用于管理 effect 所有权的 Context 时，可能意外地让该选择决定领域身份。

类型信息被擦除后，这项反向关联还需要补偿机制。Host Remote 转发会从已路由主体检查其 Context，创建流程会从调用方 Context 推断运行时父级，适配器则维护反向身份扫描。这些机制重复类型化请求中已有的身份，也掩盖了哪个调用方在运行时拥有 Agent。

若没有显式所属方，`SubagentManager` 会通过私有插件 Context 创建和恢复子级，因此基于 Context 的推断会把每个可续跑子级归类为 runtime root，尽管管理器持有其确切父级。仅限根级的消费方随后可能附加调度工具、授予直接人类输入对应的 Goal 权限，或像处理顶层 Agent 一样路由用户问题。

## 决策

运行时接口在拥有身份的位置携带 Agent 身份。`AgentSetup` 接收 `(agentCtx, agent)`；每个 subagent Activation 保留其确切运行时树根；作用域事件在 payload 中携带 Agent；Remote 转发校验 `request.agent` 就是 carrier key；Host Typert Context 解析则把协议身份映射到存活 Agent Context，不执行反向扫描。`agent.ctx` 继续拥有注册和生命周期，不暴露反向 Agent 属性。

感知作用域的注册表继续仅使用不透明作用域键判断注册成员关系。tool-subagent 不会分类该键，也不会从 Context 解析 Agent。直接 `AgentSetup` 显式接收 Agent，并在 Agent 发布前通过所给 Context 完成安装。对于由设置控制的常驻 preset，事件 payload 提供 Agent，其 Session 提供策略目标，其 Context 拥有注册项。

`SubagentManager.rootOf(agent)` 从已有 Activation 读取运行时成员关系；子级和树根都必须匹配注册表中的存活对象。普通 Session 返回自身，非托管的 subagent header 不授予成员身份。持久化 `parentSession` 描述创建关系；中间创建者离线时，Activation 保留确切树根，同 id 替代实例不能继承它。仅限根级的消费方依据显式 subagent 来源分类。

[作用域参考](../../../../packages/core/scope/README.zh.md)与 [Agent loop 参考](../../../../packages/core/agent-loop/README.zh.md)说明注册和生命周期行为。[发起方作用域决策](2026-07-15-agent-initiator-scope.zh.md)负责私有调用链理由；显式运行时归属不改变因果发起关系或注册生命周期。

## 验证

托管子级测试验证中间创建者释放，以及子级或树根替换后的确切实例检查。SDK 审批测试验证直接创建者退出后的轮次内路由。Schedule 与用户问题测试拒绝委派 Session，历史普通 fork 则保持独立。

Remote 事件测试会在转发作用域 waterfall 前拒绝缺失或不匹配的 Agent。tool-subagent 测试验证 direct setup 会在 Agent 发布前完成安装；常驻 preset 测试验证逐 Session 的策略读取与继承。

## 考虑过的替代方案

**保留 `Context.agent`。** 反向 accessor 会让注册所有权看起来等同于操作身份，还要求每个 Context 派生、适配器和测试替身保留一项与 Cordis 服务选择或 effect 清理无关的关联。

**从调用方 Context 推断运行时归属。** 私有管理器 Context、Agent Context 和常驻 preset Context 都能调用同一个工厂。因此，Context 祖先关系无法说明由哪个存活 Agent 拥有结果；subagent Activation 保留准入时传入的确切树根。

**分类 Agent 作用域键。** 不透明作用域键表达路由成员关系，而不是领域身份。分类该键会让 Agent 成为组合中心，也仍会把插件的 effect 所有者与策略所需的 Session 耦合起来。

**使用发起 Agent 作为创建归属。** 发起方作用域记录异步执行的因果关系，而非生命周期归属。父级可能发起有意创建根级 Agent 的工作，而 setup 仍位于子级驱动边界之外。

**使用持久化会话谱系。** `parentSession` 跨进程生命周期记录创建祖先关系。中间创建者可以离线，而后代仍由存活树根管理；持久 id 也无法区分替换后的 Agent 实例。历史普通 fork 可能保留父级元数据，但并不属于委派。

## 后果

生命周期 options、事件、服务请求和传输请求会携带显式 Agent 身份，因此每项操作都会声明自身使用的身份，TypeScript 也会检查两侧。Context 可以继续复用于依赖访问与 effect 所有权，而不会成为另一种领域对象定位器。

可续跑子级拥有独立于创建者驻留状态的唯一运行时树根。subagent 管理器拥有整树 teardown 和本地成员关系；核心工厂与注册表仅保留实例创建、发布和释放。第三方调用方通过 subagent 服务创建托管子级，而非给任意工厂创建的 Agent 指定归属。
