# Agent Note: Subagent 提供方生命周期事件——`subagent/provider-added` / `subagent/provider-removed`

Status: implemented
Archived: 2026-09-04

[English](2026-07-05-subagent-provider-lifecycle-events.md) | 中文

## 问题

[提示词变量 Agent Note](2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md) 让 `dsh-tool-subagent` 从其提供方派生面向模型的措辞：`SubagentProvider.inheritsParentContext`（spawn 和 ACP（Agent Client Protocol）为 `false`，fork 为 `true`）同时驱动工具描述和 `prompt` 参数描述，使 fork 工具不再在上下文继承问题上对模型撒谎。这一修复引入了跨 fiber 的数据依赖：工具描述在工具注册时固定（这是有意为之——描述是 tool-choice 引导所在之处），但提供方在自己的插件 fiber 上到达，时机不确定。

如果在工具插件的 `apply` 时刻解析提供方，就会产生一个隐式的加载顺序要求（「在 cordis.yml 中把后端列在工具前面」）。这个要求不成立，因为 Cordis Loader 并发启动同级条目，且 `Entry.init()` 不会等待激活完成：延迟到达的后端即使列在前面，也可能让工具 fiber 失败。Loader 不提供同级顺序保证——「异步状态不是同步状态」（见[防御性模式](../../../../docs/defensive-patterns.zh.md)）。

## 决策

注册表将提供方的成员变化作为类型化事件广播，消费方镜像这些事件而非假设顺序：

- **`subagent/provider-added(provider)`**：一个提供方在 `ctx.subagents` 注册表中变为可解析。在注册时发出。
- **`subagent/provider-removed(name)`**：一个提供方离开注册表（其插件 fiber 被 dispose（资源释放）——卸载或 HMR（热模块替换）重载）。从注册的 disposer 中发出。

`dsh-tool-subagent` 镜像其命名提供方的生命周期：当提供方可用（或变为可用）时注册工具——在那一刻从该提供方派生措辞——当提供方离开时注销工具，并在重新注册时（HMR 重载）重新派生。提供方不在时工具不存在，因此不会对模型撒谎。这里有意不留下任何需要文档化的加载顺序要求：事件让顺序问题消失，而非将其钉死。

这些事件还完善了 seam 的词汇：`ctx.subagents` 是一个命名注册表，多个委派后端（`spawn`、`fork`、`acp`）在其上共存；一个其他插件从中派生状态的注册表，应当以类型化事件广播成员变化，而非要求轮询或依赖加载顺序。

## 曾考虑的替代方案

- **在 `apply` 时解析提供方，不存在则抛异常**：否决。「先列后端」这一要求声称了 Loader 并不存在的顺序保证。
- **重试查找（轮询直到提供方出现）**：最终能收敛，但在框架已有的机制（effect 注册 + disposal）之外发明了一套私有就绪协议；它也无法感知提供方离开，因此 HMR 会遗留一个措辞描述已 dispose 后端的工具。
- **仅在 section 中放置 subagent 措辞，在组装时惰性解析**：同样能容忍任意加载顺序，但将 tool-choice 引导移出了描述，与提示词变量 Agent Note 建立的所有权规则相矛盾（每个工具的语义和何时使用属于描述）。响应式注册既保持描述的权威性，又不依赖顺序。
- **根据提供方名称而非提供方对象确定措辞**：`providerName` 本身是配置，重命名后的提供方会静默获得错误的措辞；从已解析提供方自身的 `inheritsParentContext` 派生则不会漂移。

## 后果

- 从命名提供方派生状态的消费方响应 `subagent/provider-added`/`-removed` 事件，而非在 `apply` 时读取注册表；`dsh-tool-subagent` 是参考实现。
- **添加时大声失败；移除时按监听器隔离。** 添加监听器可以回滚注册。移除在 disposal 期间运行，因此单个监听器抛异常只会被记录日志，不会饿死后续镜像或干扰拆解流程。`start()` 仍在每次运行时按名称解析提供方，防止陈旧工具调用已移除的后端。见[事件目录](../../../../docs/subsystems/subagent.zh.md#cordis-surface)与[生产者/消费方映射](../../../../docs/event-producer-consumer.zh.md)。
- **工具不存在的窗口期。** 在后端 disposal 与重新注册之间（HMR 重载期间），模型看不到 subagent 工具。这是诚实的状态——替代方案是一个向空处分发的工具——工具注册表发出的 `tools/change` 事件会使提示词组装保持最新状态。
- **两个等待中的 fiber 共享同一 `toolName` 是无效配置，被延迟捕获。** 如果两个 `dsh-tool-subagent` 加载实例分别指定了不同的提供方但相同的 `toolName`，两者都会等待，先到达的提供方先注册；第二次注册仅在其提供方到达时才抛异常。插件中的 `TODO(subagent-dup-toolname)` 记录了这一影响范围；工具注册表的重名拒绝机制仍是最终防线。
