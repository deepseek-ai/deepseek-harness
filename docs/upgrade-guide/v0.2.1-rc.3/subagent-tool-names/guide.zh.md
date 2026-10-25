---
kind: upgrade-guide
description: "基于 base 的配置通过模型工具中的名字寻址子代理，Host API 继续使用 Session id。"
---

# 子代理工具需要命名插件

[English](guide.md) | 中文

## 变更

子代理工具需要 `@deepseek-ai/dsh-subagent-names`，基于 base 的配置默认挂载该插件。`subagent` 和 `subagent_fork` 接受可选的同级 `name`，返回 `subagentId`，以及 `lead/reviewer` 这样的完整 `name`。省略时分配首个未使用的 `agent-N`。`send_message` 和 `interrupt_agent` 使用 `name` 参数，接受发现到的路径或现有成员的 Session id。`list_agents` 在 ID 字段之外附加名字和父路径。实验性 Team 工具提供 `ownerName`；OAR 工具也返回名字。

subagent 服务、provider 请求、Session catalog 和 SDK 句柄保留现有 ID 接口。运行时消息和完成通知仍通过 Session id 标识代理。命名插件在启动成功后将名字到 ID 的绑定记录在根 Session 中。子代理可能在名字绑定前开始第一步。委派、控制以及实验性 Team 和 OAR 工具都需要命名服务；卸载该服务会移除这些工具定义。

## 迁移

1. 将脚本中的模型工具调用从 `send_message({ agent_id: id, ... })` 改为 `send_message({ name: id, ... })`，从 `interrupt_agent({ agent_id: id })` 改为 `interrupt_agent({ name: id })`。有返回的 `name` 时，后续调用使用该名字。
2. 从创建结果中读取原有 ID 及 `name`，从发现结果中读取可用的名字，从实验性 Team 任务结果读取 `ownerName`。现有 Host `startActivation`、`sendMessage`、`interrupt` 和 `ownerId` 调用保持不变。
3. 在使用子代理工具的自定义装配中，与 subagent 服务及 Session 投影服务一起挂载 `@deepseek-ai/dsh-subagent-names`。随附的 base bundle 已提供该插件。
4. 使用 `name: "reviewer"` 创建子代理，确认结果为 `lead/reviewer`，并确认 `list_agents` 和后续消息可以解析该路径。名字在根 Session 的整个生命周期内保留。
