# Agent Note: `list_agents` uses `ready` for resumable children

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-list-agents-residency-vocabulary.md) | 中文

## 问题

`list_agents` 把可继续 child 的进程驻留状态投影为 `running | idle | complete`。`complete` 读起来像一项终态工作，且结果就在某处，但底层事实只表示没有驻留的 Activation：对话完好无损，`send_message` 可以继续它，而且它对 child 的结果不作任何断言。读到 `complete` 的模型会合理地寻找可收集结果，或向一个它以为已经结束的对话发送替代工作。

这个词与[由管理器负责的结算投递](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)同时出现时尤其容易误导。完成会以通知到达 parent；列表用于回忆持久化对话，而不是轮询该通知。

## 决策

面向模型的投影报告 `running | idle | ready`：

- **`running`** 表示驻留 Agent 存在活跃 driver。
- **`idle`** 表示 Agent 驻留但处于轮次之间，也可能正在等待它启动的 agent。
- **`ready`** 表示只剩下持久化对话。`send_message` 会在同一对话上启动下一轮；该状态表示可恢复而非终态，也不表示有结果等待收集。

工具描述会陈述这些区别，并引导模型远离轮询：它说明 child 结束时 parent 会收到通知，而列表用于回忆自己启动过哪些 child。由于任一快照都可能与另一进程或后续消息竞态，`send_message` 仍是投递时的权威检查。

服务层不变。`SubagentListEntry.activity` 保留 `'running' | 'inactive'`，对 UI 等消费方而言，这准确描述了语料驻留状态。面向模型的适配器把 `inactive` 映射为 `ready`，因为这个词表达了模型可执行的操作，而没有虚构结果。

## 考虑过的替代方案

**保留 `complete`，并在描述中限定它。** 一段解释 `complete` 不代表完成的描述，每次被读取时都在与渲染状态对抗。模型扫读的那一行必须自身表达正确区别。

**使用 `active | dormant`。** 这会删除处于轮次之间的驻留 Agent 与仅存于存储的对话之间的有效区别，并让仅存于存储的状态听起来不可用。`ready` 直接表达有用事实：同一对话可以接受下一轮。

**完全移除状态。** parent 决定是否发送更多工作时，驻留状态依然有用。移除它只是用没有信号替代一个误导性状态。

**重命名服务活动值。** `running | inactive` 在服务层是正确的，并且有非模型消费方。为了修复一个适配器的呈现而搅动通用契约并不合理；[持久化目录 Agent Note](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.zh.md) 继续拥有该服务词汇。

## 后果

- 渲染行使用 `<id> [running] — <label>`、`<id> [idle] — <label>` 或 `<id> [ready] — <label>`。
- 输出 schema 的 `status` 枚举与渲染契约一同变化。生成的工具目录会带上新描述；它只渲染每个工具的 `parameters`，从来不收录输出 schema。
- 单元覆盖固定三种映射，以及引导模型等待结算通知而非轮询本工具的描述条款。
- 整体组装的 ACP `subagent-list-agents` 场景会为已结算且可恢复的 child 渲染 `ready`。
