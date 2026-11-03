---
kind: upgrade-guide
description: "Subagent 控制工具和 Team 任务工具按名称寻址 agent，list_agents 行格式改变，subagent 目录写入第 3 版载荷。"
---

# Subagent 工具按名称寻址 agent

[English](guide.md) | 中文

## 变更

新 subagent（子智能体）在创建者的 `subagent/catalog` 中拥有同级唯一的名称。根为 `lead`；后代名称是 `reviewer/checker` 这样的路径。[subagent 运行时](../../../../packages/subagent/subagent/README.zh.md#agent-names)定义名称规则。升级前创建的子级继续以 Session id 作为名称。脚本、PTC、SDK 调用方和 transcript（文本记录）需要适配以下变更：

- `send_message({ agent_id, message })` 改为 `send_message({ agent, message })`，`interrupt_agent({ agent_id })` 改为 `interrupt_agent({ agent })`。`agent` 接受名称或 Session id。仍传入 `agent_id` 的调用无法通过参数校验。
- `subagent`、`subagent_fork` 和 `subagent_oar` 接受可选的 `name`。它们返回 `started subagent <name>`，结果为 `{ kind: 'activation', name }`。
- `list_agents` 返回 `{ name, status, description? }` 行，取代含 `kind`、`id`、`label`、`parent`、`depth` 和 `reason` 的行。不可读分支以 `status` 报告 `corrupt`、`unsupported` 或 `unavailable`。文本行格式为 `<name> [<status>] — <description>`。
- Team 任务结果以 `owner`（所有者名称）取代 `ownerId`。`team_task_list` 和 `team_task_update` 的 `owner` 接受名称。查询无所有者任务时，用 `unowned: true` 替代 `owner: "unowned"`。
- 本地创建和父级投递的外部创建写入第 3 版 `subagent/catalog` 载荷。本版本之前的发布会拒绝包含该载荷的目录，因此无法打开升级后创建过 subagent 的 Session。参见[持久化确认记录](../../../persistence-changes/2026-11-02-subagent-catalog-names.zh.md)。
- `SubagentActivation` 新增必需字段 `name`，`SubagentActivationSpec` 接受可选的 `name`。

## 迁移

1. 在脚本、PTC 程序和 SDK 调用中，将 `send_message` 和 `interrupt_agent` 的 `agent_id` 参数改名为 `agent`。传入 `list_agents` 或启动回执报告的名称；已保存的 Session id 仍可使用。
2. 更新 `list_agents` 输出的解析器，读取 `name`、`status` 和 `description`。只有完整命名路径编码创建者：最后一个 `/` 之前的前缀，不含 `/` 时为 `lead`。未命名的子级或祖先导致回退到 Session id；这些行既不提供创建者，也不提供深度。
3. 更新 Team 任务消费方，读取 `owner` 而非 `ownerId`。调用 `ctx.agentTeams` 的 host 代码仍读取 `ownerId`；展示时读取 `ownerName ?? ownerId`。新分配会持久化可选的 `ownerName`，历史记录保持不变。旧投影会拒绝带名称的任务；参见[确认记录](../../../persistence-changes/2026-11-02-team-task-owner-names.zh.md)。
4. 从委派工具结果读取 `name` 而非 `subagentId`。更新包含 `agent_id` 参数、`started subagent <Session id>` 回执、身份运行时上下文文本、`Agent <Session id> sent a message` 署名、`Background subagent <Session id>` 通知或旧 `list_agents` 行的录制 transcript 或 fixture。署名和通知现在使用名称。
5. 构造 `SubagentActivation` 值时添加 `name`。读取目录行的代码可读取可选的 `name` 字段。
6. 在创建 subagent 之前，升级所有打开同一 Session 存储的进程。旧版本无法打开包含第 3 版目录载荷的 Session。
7. 验证迁移：以 `name: "reviewer"` 启动一个 subagent，确认回执为 `started subagent reviewer`，`list_agents` 列出 `reviewer`，且 `send_message({ agent: "reviewer", message })` 成功。
