---
kind: upgrade-guide
description: "自定义 Session 控制器与 subagent 消息组合必须挂载共享 Session 控制服务。"
---

# 自定义 Session 控制需要共享服务

[English](guide.md) | 中文

## 变更

使用 `send_message` 或 `ctx.subagents.sendMessage()` 的自定义组合必须挂载 `@deepseek-ai/dsh-session-control`。subagent 消息原先直接通过 subagent 管理器投递，现在使用共享服务管理消息身份、来源标记和逐目标排序。缺少该服务时，消息发送失败，不会改走其他投递路径。现有工具参数、树内权限和恢复限制保持不变。

挂载 `@deepseek-ai/dsh-api-session-controller` 的自定义组合还需要 `@deepseek-ai/dsh-session-control-local`，由它负责普通 Session 的激活。基础 bundle 提供这两个服务。

目标接收 `send_message` 调用后，随后发生的调用方取消会保留成功回执。此前，即使目标已接收消息，工具执行仍可能把回执替换为已取消结果。在接收前取消仍会使调用失败；两种情况都不会撤回已经接收的消息。

## 迁移

1. 在负责解析插件包的自定义 profile 或 bundle 的包依赖中加入 `@deepseek-ai/dsh-session-control`。如果组合挂载 API Session Controller，还需加入 `@deepseek-ai/dsh-session-control-local`。
2. 在 Agent 与 subagent 服务共享的 Host 上下文中挂载一个 `@deepseek-ai/dsh-session-control` 行。存在 API Session Controller 时，在该上下文中挂载 `@deepseek-ai/dsh-session-control-local`。保留现有提供方和工具行；新 `session_send_message` 工具是可选的。
3. 重启组合，在同一 subagent 树中的两个 Agent 之间发送消息，确认现有工具返回回执，且接收方记录发送者的 Session id。对于自定义 Controller 组合，确认仍可创建和恢复普通 Session。
4. 即使调用方已取消，也要保留成功回执。与已接收投递竞争的取消不是重复发送的理由。接收语义见 [Session 控制](../../../subsystems/session-control.zh.md)。
