---
kind: upgrade-guide
description: "Agent Teams 使用标准 subagent 工具和分层名字；移除 Team 专属创建、消息、列举、中断操作及其配置键。"
---

# Agent Teams 使用子代理和分层名字

[English](guide.md) | 中文

## 变更

以 `lead` 为根的完整路径标识接收者；描述标注职责。创建接受可选的同级唯一名字片段；省略时从 `agent-1` 开始选择第一个未占用的 `agent-N`。

- 移除 `spawn_teammate` 以及 Team 作用域的 `send_message`、`list_agents` 和 `interrupt_agent`。标准控制工具使用 `name` 而非 `target`。同一根下的成员可以通过完整路径跨分支互发消息；中断仍只允许祖先执行。
- `list_agents` 不接受参数，列出整棵树。移除脚本中的 `scope` 参数。行使用 `kind: root|child|diagnostic`；后代包含父路径和相对根的深度。根可将任务分配给自身或任意已发现的可继续执行后代。
- Team 添加四个任务工具、任务策略和必需身份。`wait_agent` 移至普通 subagent 控制工具，等待调用者的下一步收件箱，包括待处理输入。状态变化和其他收件箱不会唤醒它；移除 `noProgress`。超时范围和默认值不变。
- `agent-team` 拒绝 `maxMembers`、`maxMessageBytes` 和 `disposalTimeoutMs`；`tool-agent-team` 拒绝 `interrupt`、`freshProvider` 和 `forkProvider`。
- `ctx.agentTeams` 移除创建、通信、中断、名册、成员关系和等待 API。移除 `TeamMembership`、`TeamMemberView`、spawn/send 类型及 `TeamWaitResult`；改用 subagent 根解析和发现。服务任务归属保留 `ownerId`；模型工具结果使用 `ownerName`。
- 运行时实例共享根所有权，不改变创建祖先关系。成员收尾不释放后代。消息仅恢复目标。根关闭时 host 关闭整棵树；成员显式获取所需结果。
- 冷恢复保留已保存的 preset 和权限；缺失 preset 会导致恢复失败。生命周期分派使用根作用域。浏览器继续执行需要根在线。
- 历史 Team 名册和邮箱记录仍可读取。其中的名字仅作为历史数据，不用于解析消息收件人或任务所有者。父级目录条目携带可选的 `name` 片段；历史未命名子级使用 `legacy:<session-id>` 路径片段。
- Web Team 面板仅显示任务；普通 subagent 导航负责浏览成员。移除 wire 的 `agentTeam.members` 和 `TeamMemberProjection`。任务提交结束同树当前等待；等待之外的变更不能唤醒后续等待。

## 迁移

1. 将 `tool-agent-team.interrupt: false` 移到 `tool-subagent-control`。删除其余废弃键，以及仅为支持 Team 而禁用 subagent 工具的 patch。
2. 将 `spawn_teammate` 替换为 `subagent({ name, description, prompt })`；使用 `subagent_fork` 继承历史。保存返回的路径。`subagent_oar` 也接受可选的 `name`。
3. 使用 `send_message({ name, message })` 和 `interrupt_agent({ name })`；通过 `list_agents` 查询路径。从 `description` 读取子级任务简介，替换 `label`。
4. 任务的 `owner` 接受路径，结果提供 `ownerName`。根为 `lead`。Host 操作保留 Session id；`startActivation()` 接受可选的 `name`，返回 `activation.name` 和 `childId`。
5. 所有 activation 都进入父级 catalog，包括外部 `delivery: 'caller'` 工作。发现接口和 Web 子级列表包含这些条目；delivery 只控制结果投递。检查统计子级的脚本。
6. 将已移除服务替换为 `ctx.subagents`。SDK `session/resume` 拒绝子级 Session；请恢复根。验证导航、任务分配和当前等待的唤醒；等待后重新读取任务。
