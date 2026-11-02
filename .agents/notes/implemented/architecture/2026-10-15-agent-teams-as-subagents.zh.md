# Agent Note: Agent Teams 队友是子代理

Status: implemented

[English](2026-10-15-agent-teams-as-subagents.md) | 中文

邻接和父级生命周期限制由[整树通信](2026-10-16-tree-wide-agent-communication.zh.md)取代。[任务板收件箱协调](2026-10-19-team-task-board-inbox.zh.md)取代独立名册和 Team 所有的等待；单一 subagent 身份决策仍有效。

## Problem

队友已经使用子代理运行时完成创建、Session 身份、目录成员关系、容量、冷恢复、结算和中断。独立 Team 成员列表重复了身份、创建恢复和释放职责。Team 作用域内的消息及控制工具覆盖标准子代理工具，迫使 profile 禁用普通委派，并使分叉工具模式偏离父级。

## Decision

统一使用子代理的 Session id 作为身份。现有 `description` 工具参数提供目录标签和展示文本；描述可以重复，不用于寻址代理。创建不接收成员名称、不预留名称，也不增加目录载荷版本。

[整树通信](2026-10-16-tree-wide-agent-communication.zh.md)在同一根树内授权当前在线发送方，并保留实际发送方 id。中断保留祖先权限和 id 寻址。

每个根 Agent 及其后代组成以根 Session id 标识的 Team。Team 不创建 agent，提供任务工具和任务策略。普通 subagent 控制工具提供必需身份、发现、通信、中断和收件箱等待。父级和 fork 子级接收相同工具 schema 和共享策略。

任务归属使用 `ownerId`；根重新分配可指定自身或任意可达的可继续执行后代。历史名册记录仅供解码。Team 持久化任务变更，不结束收件箱等待，也不启动空闲轮次；[仅等待收件箱](../simplification/2026-10-29-inbox-only-agent-wait.zh.md)负责唤醒行为。历史 `team/message/*` 记录仍可读取，但绝不再投递或确认。

本决策取代 [Agent Teams](../feature/2026-08-05-agent-teams.zh.md) 的成员列表、创建、恢复和消息决策，以及 [Team 直接收件箱决策](../../archived/simplification/2026-09-26-team-direct-inbox.md)。任务板和共享工作树决策仍有效。[相邻 Agent 消息](2026-08-27-adjacent-agent-steer-messaging.zh.md)纳入同级路由，[必需运行时身份](2026-10-13-team-identity-runtime-context.zh.md)负责角色声明。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.zh.md)列出移除的工具、方法和配置。

## Alternatives considered

**独立 Team 权限和工具。** 这会为子代理运行时已拥有的 Agent 保留第二套成员列表与恢复生命周期，以及同名工具和私有投递适配器。共同父级关系已经提供所需权限。

**以唯一名称选择性启用同级路由。** 名称会在现有 Session id 之外增加校验、预留、持久化和歧义解析。描述已能说明职责；稳定 id 可以区分重复描述，无需另一套身份系统。

**可插拔地址簿。** 注册表可支持跨不同父级的组，但会增加另一种授权输入。当前没有消费者需要此能力；协作必须跨父级树时再考虑。

## Consequences

树内成员通过普通控制工具发现和联系彼此。Team 保留任务归属、依赖和任务策略。容量和生命周期遵循 subagent 规则；启动失败不会创建 Team 名册行。现有持久化任务代次保持不变。

任意深度后代共享任务板，均可成为任务所有者。历史成员不授予权限。独立工作目录仍由调用者显式选择；不支持跨进程任务协调。

## Testing

验证覆盖具有实际发送方归属的整树投递和冷恢复、任务 CAS 与所有者发现、历史解码、收件箱等待隔离和注册释放。录制会话覆盖 Team 策略和身份，以及普通 subagent 返回指导。
