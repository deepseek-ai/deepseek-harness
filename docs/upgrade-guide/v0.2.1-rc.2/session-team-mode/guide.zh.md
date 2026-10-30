---
kind: upgrade-guide
description: "Agent Teams 在新 Session 中默认关闭，并使用按 Session 保存的选择。"
---

# 按 Session 选择智能体团队

[English](guide.md) | 中文

## 变更

Agent Teams 随基于 base 的 profile 提供；新 Session 默认关闭。插件页不再提供独立的智能体团队开关。根 Session 的选择控制整棵子代理树中的任务工具和 Team 提示词。模型与推理等级菜单提供**使用智能体团队**开关，开启后通过根会话的 Subagent 页头入口，在同一面板中查看上方成员与下方共享任务。子会话保留导航，不显示共享任务板。

关闭 Team 保留任务和子代理。已经进入执行的任务操作继续完成；排队中的操作在开始时检查当前模式。选择在重启后仍有效。没有保存选择的历史任务板保持开启。必读事件 `team/mode` 记录选择；旧读取器会拒绝该未知事件。参见[持久化变更确认](../../../persistence-changes/2026-10-19-session-team-mode.zh.md)。

## 迁移

1. 启动每个已有 profile 一次。加载时会移除已停用的 `@deepseek-ai/dsh-experimental-agent-team-profile` 组合选项；base 与 Web 组合提供对应插件。保留 `agent-team`、`tool-agent-team` 与 `ui-agent-team` 行覆盖。自定义组合将包名 `@deepseek-ai/dsh-experimental-agent-team`、`@deepseek-ai/dsh-experimental-tool-agent-team`、`@deepseek-ai/dsh-experimental-client-ui-agent-team` 分别替换为 `@deepseek-ai/dsh-agent-team`、`@deepseek-ai/dsh-tool-agent-team`、`@deepseek-ai/dsh-client-ui-agent-team`。
2. 在根会话的模型与推理等级菜单中切换**使用智能体团队**。`/team on` 与 `/team off` 命令已移除。
3. 在根会话中确认开启后通过 Subagent 入口在树下方查看共享任务板，并提供四个任务工具。重新加载 Session，确认选择已保存。关闭后再开启会恢复已有任务。

Client 插件消费者将 `TeamActionProps` 替换为 `TeamBoardProps`；任务内容注册到 `conversation.session.header.actions.subagent.footer`，而非页头操作插槽。
