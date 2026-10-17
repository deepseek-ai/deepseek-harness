# Agent Note: Agent Teams 队友是子代理

Status: implemented

[English](2026-10-15-agent-teams-as-subagents.md) | 中文

邻接消息、发现范围和父子生命周期限制已由[整树通信](2026-10-16-tree-wide-agent-communication.zh.md)替代；其余决策仍然有效。

## Problem

队友已经使用子代理运行时完成创建、Session 身份、目录成员关系、容量、冷恢复、结算和中断。独立 Team 成员列表重复了身份、创建恢复和释放职责。Team 作用域内的消息及控制工具覆盖标准子代理工具，迫使 profile 禁用普通委派，并使分叉工具模式偏离父级。

## Decision

统一使用子代理的 Session id 作为身份。现有 `description` 工具参数提供目录标签和展示文本；描述可以重复，不用于寻址代理。创建不接收成员名称、不预留名称，也不增加目录载荷版本。

确切在线的发送方可向直接可继续子级发消息。驻留的可继续子级还可按 id 联系直接父级或可继续同级。同级投递使用共同在线父级对子级的权限和冷恢复能力；消息保留实际发送方 id。`list_agents` 提供父级和同级 id。中断保留祖先权限和 id 寻址。

每个根 Agent 领导以自身 Session id 标识的 Team；其下所有在线子代理共享任务板和等待。成员列表投影根、其直接可继续目录子级和历史 `team/member` 记录。Team 不创建代理，也不注册消息、列举或中断工具。Team profile 只增加配置行。父级与分叉子级获得相同 Team 策略和工具模式，角色身份通过必需运行时上下文提供。

任务所有权使用 `ownerId`，重新分配接受 Session id。Team 只持久化任务变更。消息使用目标 Agent 收件箱；历史 `team/message/*` 记录仍可读取，但不会被投递或确认。

本决策取代 [Agent Teams](../feature/2026-08-05-agent-teams.zh.md) 的成员列表、创建、恢复和消息决策，以及 [Team 直接收件箱决策](../../archived/simplification/2026-09-26-team-direct-inbox.md)。任务板和共享工作树决策仍有效。[相邻 Agent 消息](2026-08-27-adjacent-agent-steer-messaging.zh.md)纳入同级路由，[必需运行时身份](2026-10-13-team-identity-runtime-context.zh.md)负责角色声明。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.1/agent-team-subagents/guide.zh.md)列出移除的工具、方法和配置。

## Alternatives considered

**独立 Team 权限和工具。** 这会为子代理运行时已拥有的 Agent 保留第二套成员列表与恢复生命周期，以及同名工具和私有投递适配器。共同父级关系已经提供所需权限。

**以唯一名称选择性启用同级路由。** 名称会在现有 Session id 之外增加校验、预留、持久化和歧义解析。描述已能说明职责；稳定 id 可以区分重复描述，无需另一套身份系统。

**可插拔地址簿。** 注册表可支持跨不同父级的组，但会增加另一种授权输入。当前没有消费者需要此能力；协作必须跨父级树时再考虑。

## Consequences

普通可继续同级可发现彼此并发消息。Team 保留任务所有权、依赖、等待、策略和角色身份。成员数量限制、消息大小限制和 Team 自有释放被移除，改用子代理容量与生命周期。启动失败不留下 Team 成员行。不需要新的 Session 载荷代际，历史成员名称只作为解码数据保留。

更深的后代共享任务和等待，但不显示成员行；消息路由仍限于自己的父级、子级和可继续同级。仍不支持独立工作目录和跨进程协调。

## Testing

验证同级投递、冷恢复、实际发送方归属和重复描述，并拒绝无关目标。验证 Team 谱系、继承目录隔离、历史读取、任务 CAS、等待和注册释放。录制 Team 会话与 headless profile 验证完整模型工作流以及父级和分叉请求前缀相等。
