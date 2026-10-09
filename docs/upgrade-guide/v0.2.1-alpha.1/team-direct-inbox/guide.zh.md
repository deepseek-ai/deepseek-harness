---
kind: upgrade-guide
description: "Agent Teams 移除待投递消息数量限制，并停止投递历史排队消息。"
---

# Agent Teams 消息使用目标收件箱

[English](guide.md) | 中文

## 变更

实验性 Agent Teams 插件将新消息直接发送到目标 Agent 收件箱，不再保留独立的 Team 邮箱。`send_message` 仅返回 `{ "sent": true }`，不暴露消息 ID，也不返回 `accepted` 或 `queued` 状态。接收成功不表示模型已处理消息，也不保证同步刷新到存储。失败的发送不会保留以供重试，显式重发也不会去重。

配置键 `maxPendingMessagesPerMember` 已移除。历史 `team/message/queued` 和 `team/message/delivered` 记录仍可读取，但升级前尚未投递的排队消息永远不会被派发。成员名单与任务状态仍然持久保存。

## 迁移

1. 升级前，让待投递的 Team 消息完成投递，并确认目标已收到。升级后，显式重发仍需处理的未投递消息；先检查目标历史，避免重复。不要编辑历史 Session 记录。
2. 从 `cordis.yml` 或覆盖配置中 `@deepseek-ai/dsh-experimental-agent-team` 插件的配置移除 `maxPendingMessagesPerMember`。没有替代的 Team 队列限制；`maxMessageBytes` 仍限制包含发送者标识的完整消息大小。
3. 更新所有读取 `send_message` 结果的调用方，改为读取 `sent` 而非消息 ID 或投递状态，并显式处理发送错误。不要把发送成功视为目标工作已完成。`ctx.agentTeams.sendMessage()` 服务仍返回 `messageId`。
4. 启动启用 Team 的 profile，向其他成员发送消息，确认工具返回 `{ "sent": true }` 且目标收到消息。投递语义参见[包参考](../../../../packages/experimental/agent-team/README.zh.md#use-this-package)。
