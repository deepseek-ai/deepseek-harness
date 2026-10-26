---
kind: upgrade-guide
description: "空的普通 Agent 输入发起请求，但不产生 user/message 事件。"
---
# 通过 inbox 观察空 prompt 准入

[English](guide.md) | 中文

## 变更

普通 Agent 输入的 `content: []` 基于已提交历史启动新轮次，不再追加空的 `user/message`。带身份的输入仍保留在持久 inbox 事件中。若自定义消费者等待每条已接受输入产生用户消息，应改为观察对应 inbox 回执。Session 日志无需迁移，历史空用户消息的解释保持不变。

Web Session prompt 端点仅在普通 Session 空闲、最新失败符合继续条件且使用 queue 模式时接受空数组。仅含空白的文本块仍无效。

## 迁移

1. 普通文本和附件输入保持不变。仅在需要再次请求模型而不添加用户文本时使用空数组。
2. 通过 `agent/inbox/spliced` 中的输入身份匹配准入，然后观察正常轮次与状态生命周期。不要等待空的 `user/message`。
3. 验证继续操作增加正常闭合的轮次，但不增加用户消息。内置 TypeScript 和 Python SDK 客户端已观察 inbox 回执。
