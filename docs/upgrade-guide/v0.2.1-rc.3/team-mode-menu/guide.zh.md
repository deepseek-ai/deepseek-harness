---
kind: upgrade-guide
description: "Team 模式斜杠命令已移除，请使用根会话菜单。"
---

# 从会话菜单选择 Team 模式

[English](guide.md) | 中文

## 变更

`/team on` 和 `/team off` 不再注册。根会话的**使用智能体团队**开关直接调用 `remote.agentTeams.setEnabled`。保存的选择、任务保留以及仅允许根会话修改的授权规则不变。

## 迁移

1. 在根会话的模型与推理等级菜单中打开或关闭**使用智能体团队**。
2. 执行该命令的插件改为调用 `ctx.agentTeams.setEnabled(rootAgent, enabled)`；浏览器客户端调用 `remote.agentTeams.setEnabled(rootSessionId, enabled)`。
3. 重新加载 Session，确认开关反映已保存的选择。
