---
kind: upgrade-guide
description: 空 API 和 SDK 提示词变为重试控制输入，其必读 Session 事件需要更新后的读取方。
---

# 空提示词与重试控制输入

[English](guide.md) | 中文

## 变更

Session prompt API 接受 `content: []`，在 queue 模式下继续符合条件且空闲的失败会话。SDK `session/prompt` 将空 `contentBlocks` 映射到同样的 retry 来源控制输入。接受后记录带 `turn`、`step`、`inputId` 和 `source` 的 `agent/retry`，而非 `user/message`。新轮次仍正常开启和闭合。直接使用普通空用户消息的 Agent 调用方保留原有行为。

新增必读事件及 retry 来源保留当前 Session 格式版本。更新后的读取方接受旧日志；旧读取方会拒绝包含未知必读事件的日志。见[持久化确认记录](../../../persistence-changes/2026-10-27-retry-control-input.zh.md)。

## 迁移

1. 打开包含重试控制输入的日志前，同时升级 Session 读取方与 SDK 运行时。
2. 通过 `user/message` 关联空 API 或 SDK 提示词的消费方，改用持久 inbox 身份与 `agent/retry.inputId`。处理 retry 来源时，不应将其视为模型可见用户内容。
3. 确认继续失败请求会产生正常开启并闭合的新轮次和 `agent/retry`，而派生模型历史中没有额外用户消息。
