---
kind: upgrade-guide
description: "Agent Teams 使用标准 subagent 工具和 Session id；移除 Team 专属创建、消息、列举、中断操作及其配置键。"
---

# Agent Teams 使用子代理和 Session id

[English](guide.md) | 中文

## 变更

实验性 Agent Teams 插件使用标准子代理工具和 Session id。描述标注职责；重复描述不能标识接收者。

- 移除 `spawn_teammate` 以及 Team 作用域的 `send_message`、`list_agents` 和 `interrupt_agent`。标准控制工具使用 `agent_id` 而非 `target`。同一根下的成员可以通过 id 跨分支互发消息；中断仍只允许祖先执行。
- `list_agents` 不接受参数，列出整棵树。移除脚本中的 `scope` 参数。行使用 `kind: root` 或 `kind: child`；后代包含父 id 和相对根的深度。根可将任务分配给自身或任意已发现的可继续执行后代。
- Team 添加四个任务工具和任务策略。`wait_agent` 移至普通 subagent 控制工具，等待调用者的下一步收件箱，包括待处理输入。状态变化和其他收件箱不会唤醒它；移除 `noProgress`。超时范围和默认值不变。
- `agent-team` 拒绝 `maxMembers`、`maxMessageBytes` 和 `disposalTimeoutMs`；`tool-agent-team` 拒绝 `interrupt`、`freshProvider` 和 `forkProvider`。
- `ctx.agentTeams` 移除创建、通信、中断、名册、成员关系和等待 API。移除 `TeamMembership` 和 `TeamMembers`；改用 subagent 根解析和发现。任务归属使用 `ownerId`，包括根的 Session id。
- 运行时实例共享根所有权，不改变创建祖先关系。成员收尾不释放后代。消息仅恢复目标。根关闭时 host 关闭整棵树；成员显式获取所需结果。
- 冷恢复使用已保存的 preset 和权限，而非创建者当前代次。缺失 preset 会导致恢复失败；历史目标没有保存 preset 时，使用 host 组合及描述符覆盖。生命周期分派使用根作用域，同时在 `parentSessionId` 中保留直接创建者。浏览器继续执行需要根在线；失败使用 `subagent/delivery-unavailable`。
- 历史 Team 名册和邮箱记录仍可读取。其中的名字仅作为历史数据，不用于解析消息收件人或任务所有者。Subagent catalog 载荷不变。
- Web Team 面板仅显示任务；普通 subagent 导航负责浏览成员。历史 `agentTeam.members` 仍可解码，但不授予权限。任务提交仅向本地在线同伴发送合并的不唤醒通知。`TEAM_TASK_NOTIFICATION_FAILED` 报告 `committedTask` 和 `failedRecipients`；修改已经提交。

## 迁移

1. 删除废弃配置键，以及仅为支持 Team 而禁用 subagent 工具的 patch 行。
2. 将 `spawn_teammate({ name, description, prompt, context })` 替换为 `subagent({ description, prompt })`；继承对话历史时使用 `subagent_fork`。保存返回的 agent id。
3. 使用 `send_message({ agent_id, message })` 和 `interrupt_agent({ agent_id })`。通过 `list_agents` 查询所有 Team 成员的 id。
4. 任务的 `owner` 字段传入成员 Session id，结果读取 `ownerId`。以 Lead 的 Session id 取代 `lead` 别名。
5. 将已移除服务调用替换为 `ctx.subagents` 操作。为 `tool-subagent-control` 提供 `systemPrompt`。将上下文排序键 `TEAM_IDENTITY` 替换为 `SUBAGENT_IDENTITY`。验证成员导航、向嵌套后代分配任务和任务通知。通知失败时，恢复前读取 `committedTask`；绝不盲目重试创建。
