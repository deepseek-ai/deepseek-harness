# Agent Note: 模型可见的 Agent 可用状态与 Team 目标

Status: implemented

[English](2026-09-15-model-agent-availability-and-team-targets.md) | 中文

## 问题

Team 操作接受成员名称，但同时返回名称和 Session UUID 容易使模型选择不可用的地址。已加载与仅存储的 agent 也有不同的内部状态，尽管模型继续其工作时采取相同操作。

## 决策

Team 工具适配器从现有成员名称生成 `target`，并从创建和列表结果中省略成员 Session ID。消息、中断和任务分配使用同一名称。任务的 `ownerName`、任务 ID 和消息 ID 保持现有含义。内部服务、Web 视图和持久化 Team 记录保留 Session 身份。

普通 subagent 工具结果与 Team 服务视图把已加载但处于轮次之间的 agent 和仅存储的 agent 都投影为 `inactive`。只有正在执行轮次时才是 `running`；Team 保留表示成员创建状态的 `provisioning` 与 `failed`，普通 subagent 的诊断行保留读取失败原因。中断结果按同一规则投影之前的状态。可用状态不报告任务结果或等待依赖。

Team 服务为工具和 Web 统一提供 roster 与中断的可用状态。普通 subagent 的投影归其列表工具所有。运行时加载、冷恢复、中断权限和邮箱投递保持现有行为。普通 subagent 继续使用 `agent_id`；稳定的 subagent 名称和历史数据处理暂缓。不修改持久化类型或 Session 格式。

## 考虑过的替代方案

**立即为普通 subagent 增加稳定名称。** 这需要持久化命名策略，以及对历史无名称子级的明确处理。它与移除误导性的 Team 身份和模型状态区别相互独立。

**合并内部运行状态。** 驻留状态决定投递是启动已加载的 agent，还是从存储恢复。底层 Agent 状态与注册表中的存在性保留该区别；Team 视图仅暴露轮次可用状态。

## 影响

模型可以把 Team 结果的 target 直接复制到适用操作。这些工具结果不再提供成员 UUID 和驻留细节；Team 寻址不需要它们。在另行决定命名方案之前，普通 subagent 与 Team 的寻址方式仍不同。

定向服务与工具测试覆盖所有状态投影、返回目标的操作、诊断行和在线与仅存储子级。录制的 headless Team 与 SDK subagent 场景固定组装后的模型输出和 schema。[Agent Teams 决策](../feature/2026-08-05-agent-teams.zh.md)继续拥有 roster 持久化、作用域和权限规则。
