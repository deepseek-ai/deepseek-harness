---
kind: upgrade-guide
description: "Agent Teams 使用标准 subagent 工具和 Session id；移除 Team 专属创建、消息、列举、中断操作及其配置键。"
---

# Agent Teams 使用子代理和 Session id

[English](guide.md) | 中文

## 变更

实验性 Agent Teams 插件使用标准子代理工具和 Session id。描述标注职责；重复描述不能标识接收者。

- 移除 `spawn_teammate` 以及 Team 作用域的 `send_message`、`list_agents` 和 `interrupt_agent`。标准控制工具使用 `agent_id` 而非 `target`。同一根下的成员可以通过 id 跨分支互发消息；中断仍只允许祖先执行。
- `list_agents` 不接收参数，列出整个 Team，包括根与调用方。移除脚本中的 `scope` 参数。根行使用 `kind: root`；后代行使用 `kind: child`，包含父级 id 和相对根的深度。更新依赖 `parent` 或 `sibling` 行的消费者。发现成员不会授予任务指派权限。
- Team profile 不再禁用 subagent 工具。Team 只增加任务工具、`wait_agent` 和协作提示。
- `agent-team` 拒绝 `maxMembers`、`maxMessageBytes` 和 `disposalTimeoutMs`；`tool-agent-team` 拒绝 `interrupt`、`freshProvider` 和 `forkProvider`。
- `ctx.agentTeams` 移除 `spawnTeammate()`、`sendMessage()`、`interrupt()` 和 `listMembers()`。任务视图以 `ownerId` 取代 `ownerName`；包括 Lead 在内，任务所有者均使用 Session id。
- 创建关系保持不变，运行实例统一归 Team 根管理。成员完成或释放时不再等待或释放其后代。消息只恢复收件人，离线的创建者保持离线。宿主在根关闭时关闭整个 Team；成员需要其他任务的结果时须显式等待。
- 冷恢复使用目标保存的 preset 和权限策略，不加入创建者当前 preset 代际。已保存的 preset 缺失时拒绝恢复；没有保存 preset 的历史目标使用宿主组装，并应用记录的 descriptor 覆盖。`subagent/start` 与 `subagent/end` 通过 Team 根作用域派发，并在 `parentSessionId` 中携带直接创建者；SDK 完成通知保留该创建者。浏览器续接要求根在线，不要求创建者在线；根不可用使用 `subagent/delivery-unavailable`，不再使用 `subagent/parent-unavailable`。
- 历史 Team 名册和邮箱记录仍可读取。其中的名字仅作为历史数据，不用于解析消息收件人或任务所有者。Subagent catalog 载荷不变。

- `agentTeam.members` 携带 Lead 和历史成员。浏览器消费者将其与可继续的 `subagentCatalog` 条目组合，重复 id 优先使用目录条目。

## 迁移

1. 删除废弃配置键，以及仅为支持 Team 而禁用 subagent 工具的 patch 行。
2. 将 `spawn_teammate({ name, description, prompt, context })` 替换为 `subagent({ description, prompt })`；继承对话历史时使用 `subagent_fork`。保存返回的 agent id。
3. 使用 `send_message({ agent_id, message })` 和 `interrupt_agent({ agent_id })`。通过 `list_agents` 查询所有 Team 成员的 id。
4. 任务的 `owner` 字段传入成员 Session id，结果读取 `ownerId`。以 Lead 的 Session id 取代 `lead` 别名。
5. 将已移除的服务调用替换为 `ctx.subagents.startActivation()`、`sendMessage()`、`interrupt()` 和 `listDescendants(ctx.subagents.rootOf(caller).id)`。启动启用 Team 的 profile，确认面板显示子代理描述，且通过 id 发送的消息到达该子代理。
