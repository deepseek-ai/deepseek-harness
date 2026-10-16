---
kind: upgrade-guide
description: "Agent Teams 使用标准 subagent 工具与唯一 agent 名字；Team 专用创建、消息、列表、中断工具及其配置键被移除。"
---

# Agent Teams 使用 subagent 与唯一 agent 名字

[English](guide.md) | 中文

## 变更

实验性 Agent Teams 插件与 subagent 共享创建、发现、消息与中断。使用 `subagent` 或 `subagent_fork` 启动队友，为其指定树内唯一的 `name`，用 `description` 描述职责，并以返回的名字发送消息和分配任务。描述可以重复，不标识接收方。

- `spawn_teammate` 及 Team 作用域的 `send_message`、`list_agents`、`interrupt_agent` 被移除。标准控制工具使用 `name`，而非 `agent_id` 或 `target`。同一在线父级的可继续子级可以按名字互发消息。
- `list_agents` 不接受参数，始终列出所有可达的可继续后代，以及可继续调用方的在线父级和同级。脚本调用需移除 `scope` 参数。列出更深后代不授予消息或任务分配权限。
- Team profile 不再禁用 subagent 工具。Team 只增加任务工具、`wait_agent` 和协作指引。
- `agent-team` 拒绝 `maxMembers`、`maxMessageBytes` 与 `disposalTimeoutMs`；`tool-agent-team` 拒绝 `interrupt`、`freshProvider` 与 `forkProvider`。
- `ctx.agentTeams` 移除 `spawnTeammate()`、`sendMessage()`、`interrupt()` 与 `listMembers()`。宿主任务视图保留 `ownerId` Session 身份；面向模型的任务结果公开 `ownerName`，任务 `owner` 参数使用名字。根 agent 始终名为 `lead`。
- 历史 Team 成员列表和邮箱记录仍可读取。其中的名字属于历史数据，不解析消息接收方或任务负责人。新的 catalog 和 descriptor 记录包含名字，执行结束后仍被占用；旧的无名子级在发现时获得 `legacy:<session-id>` 地址。

## 迁移

1. 移除废弃配置键，以及仅为 Team 支持而禁用 subagent 工具的 patch 行。
2. 将 `spawn_teammate({ name, description, prompt, context })` 改为 `subagent({ name, description, prompt })`，需要继承会话历史时使用 `subagent_fork`。选择唯一的小写名字，只含字母、数字、下划线或连字符，并以字母开头。`lead` 和 `unowned` 为保留名。重名在创建前失败。
3. 使用 `send_message({ name, message })` 与 `interrupt_agent({ name })`。通过 `list_agents` 发现父级和同级名字。
4. 向任务 `owner` 字段传成员名字，读取工具结果中的 `ownerName`。根 agent 使用 `lead`。
5. 将移除的服务调用改为 `ctx.subagents.startActivation()`、`sendMessage()`、`interrupt()` 与 `listChildren()`。向 `startActivation()` 提供 `name`；宿主控制 API 仍使用 Session id。创建与普通名字查找要求根 catalog 可读。根登记失败不会留下可用的命名子级；可使用相同名字和新 child id 重试创建。启动启用 Team 的 profile，确认子级描述出现在 Team 面板，并且按名字发送的消息能够到达。
