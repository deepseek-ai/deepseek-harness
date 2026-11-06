---
kind: upgrade-guide
description: "Agent 停止接纳新工作后，输入和维护方法会抛出 AgentClosedError。"
---

# 处理关闭期间被拒绝的 Agent 输入

[English](guide.md) | 中文

## 变更

在 v0.2.2-rc.1 中，调用方持有的 `Agent` 在清理过程中仍可能接收输入。现在，Agent 的生命周期信号一旦中止，就会以 `AgentClosedError` 拒绝新输入和维护工作。已接纳的工作收尾期间，注册表中仍可能找到该 Agent。

## 迁移

1. 若扩展调用 `Agent.send`、`followup`、`steer`、`inject` 或 `runMaintenance`，请在调用处处理从 `@deepseek-ai/dsh-agent` 导出的同步异常 `AgentClosedError`。收到 `AGENT_CLOSED` 时按 Agent 不可用处理，保留其他失败的处理逻辑。
2. 在维护任务尚未结束时开始释放 Agent 以验证改动。之后调用输入方法应抛出 `AgentClosedError`，且不向 inbox 添加条目。
