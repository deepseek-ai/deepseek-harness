---
kind: upgrade-guide
description: "Agent Teams 使用标准 subagent 工具和 Session id；移除 Team 专属创建、消息、列举、中断操作及其配置键。"
---

# Agent Teams 使用子代理和 Session id

[English](guide.md) | 中文

## 变更

描述标注职责；仅 Session id 标识接收者。

- 移除 `spawn_teammate` 以及 Team 作用域的 `send_message`、`list_agents` 和 `interrupt_agent`。标准控制工具使用 `agent_id` 而非 `target`。同一根下的成员可以通过 id 跨分支互发消息；中断仍只允许祖先执行。
- `list_agents` 不接受参数，列出整棵树。移除脚本中的 `scope` 参数。行使用 `kind: root`、`kind: child` 或 `kind: diagnostic`；后代包含父 id 和相对根的深度。
- Team 提供四个任务工具和策略；控制工具提供必需身份。`wait_agent` 移至普通 subagent 控制工具，等待调用者的下一步收件箱，包括待处理输入。状态变化和其他收件箱不会唤醒它；移除 `noProgress`。超时范围和默认值不变。
- `agent-team` 拒绝 `maxMembers`、`maxMessageBytes` 和 `disposalTimeoutMs`；`tool-agent-team` 拒绝 `interrupt`、`freshProvider` 和 `forkProvider`。
- `ctx.agentTeams` 移除创建、通信、中断、名册、成员关系和等待 API。`TeamMembership`、`TeamMemberView`、spawn/send 请求和结果类型以及 `TeamWaitResult` 被移除。任务归属使用 `ownerId`，包括根的 Session id。
- 运行时实例共享根所有权，不改变创建祖先关系。成员收尾不释放后代。消息仅恢复目标。根关闭时 host 关闭整棵树；成员显式获取所需结果。
- 冷恢复使用已保存的 preset 和权限，而非创建者当前代次。缺失 preset 会导致恢复失败；历史目标没有保存 preset 时，使用 host 组合及描述符覆盖。生命周期分派使用根作用域，同时在 `parentSessionId` 中保留直接创建者。浏览器继续执行需要根在线；失败使用 `subagent/delivery-unavailable`。
- 历史 Team 名册和邮箱记录仍可读取。其中的名字仅作为历史数据，不用于解析消息收件人或任务所有者。Subagent catalog 载荷不变。
- Web Team 面板仅显示任务；subagent 导航负责浏览成员。线上 `agentTeam.members` 字段与 `TeamMemberProjection` 被移除；持久化成员状态仍可解码。任务提交不结束等待、不投递消息，也不启动空闲 Agent。需要另一个 Agent 处理任务变更时，应发送消息。

## 迁移

1. 将 `interrupt: false` 从 `tool-agent-team` 移到 `tool-subagent-control`。删除其余废弃键，以及仅为支持 Team 而禁用 subagent 工具的 patch 行。
2. 将 `spawn_teammate({ name, description, prompt, context })` 替换为 `subagent({ description, prompt })`；继承对话历史时使用 `subagent_fork`。保存返回的 agent id。
3. 使用 `send_message({ agent_id, message })` 和 `interrupt_agent({ agent_id })`。通过 `list_agents` 查询所有 Team 成员的 id。
4. 任务的 `owner` 字段传入成员 Session id，结果读取 `ownerId`。以 Lead 的 Session id 取代 `lead` 别名。
5. 将 `spawnTeammate`、`sendMessage` 和 `interrupt` 替换为 `ctx.subagents.startActivation`、`sendMessage` 和 `interrupt`。将 `membership`/`tryMembership` 替换为 `rootOf`，将 `listMembers` 替换为 `listDescendants`。将 `waitForChange` 替换为 `wait_agent`，随后重新读取任务。
6. SDK `session/resume` 拒绝子代理会话。改为恢复根 Session。验证导航、嵌套任务分配，以及消息结束收件箱等待而任务提交不会。
