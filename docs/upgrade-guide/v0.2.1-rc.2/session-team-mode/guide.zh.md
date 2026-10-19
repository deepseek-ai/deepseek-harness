---
kind: upgrade-guide
description: "Agent Teams 在新 Session 中默认关闭，并使用按 Session 保存的选择。"
---

# 按 Session 选择智能体团队

[English](guide.md) | 中文

## 变更

安装 Agent Teams 组合后可以使用此功能；新 Session 默认关闭。根 Session 的选择控制整棵子代理树中的任务工具和 Team 提示词。模型与推理等级菜单提供**使用智能体团队**开关，开启时标题栏显示共享任务。成员沿用现有 Subagent 树。

关闭 Team 保留任务和子代理。选择在重启后仍有效。没有保存选择的历史任务板保持开启。必读事件 `team/mode` 记录选择；旧读取器会拒绝该未知事件。参见[持久化变更确认](../../../persistence-changes/2026-10-19-session-team-mode.zh.md)。

## 迁移

1. 在根会话的模型与推理等级菜单中打开**使用智能体团队**，或执行 `/team on`。使用 `/team off` 关闭。
2. 需要自动开启的部署可将 `agent-team` 插件的 `config.enabledByDefault` 设为 `true`。已保存的选择和历史任务板优先。
3. 确认开启后显示共享任务板，并提供四个任务工具。重新加载 Session，确认选择已保存。关闭后再开启会恢复已有任务。
