---
kind: upgrade-guide
description: "Agent 输入方法在其所有者或工厂开始释放后拒绝消息。"
---

# 已释放的 Agent 拒绝新输入

[English](guide.md) | 中文

## 变更

保留 `Agent` 句柄的插件无法再在其所有者或工厂开始释放后追加输入。`send`、`followup`、`steer` 和 `inject` 现在会在修改收件箱前抛出错误码为 `AGENT_INPUT_CLOSED` 的 `AgentInputClosedError`。此前，这些调用可能追加已经释放的 Agent 永远不会处理的输入。单独调用 `cancel({ kind: 'disposed' })` 不会释放句柄，仍保留现有的输入暂存行为。

## 迁移

1. 在所属作用域卸载时停止生产方并释放保留的 Agent 句柄。不要在其所有者或工厂开始释放后使用句柄。
2. 如果投递可能有意与释放并发，处理 `@deepseek-ai/dsh-agent` 导出的 `AgentInputClosedError`，并报告消息未被接收。停止依赖该投递的后续操作，不要重试同一个已释放句柄。
3. 验证与释放竞争的发送会报告该错误，且不会创建收件箱条目。普通在线 Agent 的投递与活动取消保留现有行为；参见 [Agent API](../../../subsystems/core.zh.md)。
