---
kind: upgrade-guide
description: "Agent Teams 使用标准 subagent 工具和 Session id；移除 Team 专属创建、消息、列举、中断操作及其配置键。"
---

# Agent Teams 使用子代理和 Session id

[English](guide.md) | 中文

## 变更

实验性 Agent Teams 插件与 subagent 共用代理创建、发现、消息和中断能力。使用 `subagent` 或 `subagent_fork` 创建队友，以 `description` 描述职责，并用返回的 agent id 发送消息和分配任务。描述可以重复，不能作为收件人标识。

- 移除 `spawn_teammate` 以及 Team 作用域的 `send_message`、`list_agents` 和 `interrupt_agent`。标准控制工具使用 `agent_id` 而非 `target`。同一个在线父代理的可继续子代理可以通过 id 互发消息。
- Team profile 不再禁用 subagent 工具。Team 只增加任务工具、`wait_agent` 和协作提示。
- `agent-team` 拒绝 `maxMembers`、`maxMessageBytes` 和 `disposalTimeoutMs`；`tool-agent-team` 拒绝 `interrupt`、`freshProvider` 和 `forkProvider`。
- `ctx.agentTeams` 移除 `spawnTeammate()`、`sendMessage()`、`interrupt()` 和 `listMembers()`。任务视图以 `ownerId` 取代 `ownerName`；包括 Lead 在内，任务所有者均使用 Session id。
- 历史 Team 名册和邮箱记录仍可读取。其中的名字仅作为历史数据，不用于解析消息收件人或任务所有者。Subagent catalog 载荷不变。

## 迁移

1. 删除废弃配置键，以及仅为支持 Team 而禁用 subagent 工具的 patch 行。
2. 将 `spawn_teammate({ name, description, prompt, context })` 替换为 `subagent({ description, prompt })`；继承对话历史时使用 `subagent_fork`。保存返回的 agent id。
3. 使用 `send_message({ agent_id, message })` 和 `interrupt_agent({ agent_id })`。通过 `list_agents` 查询父代理和兄弟代理的 id。
4. 任务的 `owner` 字段传入成员 Session id，结果读取 `ownerId`。以 Lead 的 Session id 取代 `lead` 别名。
5. 将已移除的服务调用替换为 `ctx.subagents.startActivation()`、`sendMessage()`、`interrupt()` 和 `listChildren()`。启动启用 Team 的 profile，确认面板显示子代理描述，且通过 id 发送的消息到达该子代理。
