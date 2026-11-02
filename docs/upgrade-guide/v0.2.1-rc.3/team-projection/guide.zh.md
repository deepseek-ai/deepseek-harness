---
kind: upgrade-guide
description: "Team 投影停止恢复历史队友与邮箱状态，同时保留任务和保存的模式。"
---

# Team 投影保留任务与模式

[English](guide.md) | 中文

## 变更

`agentTeam` 投影不再从历史 `team/member` 和 `team/message/*` 事件恢复 `members`、`messages` 或 `delivered`。投影忽略这些载荷，因此历史名册或邮箱校验失败不再阻止任务读写。不恢复历史队友，也不投递排队邮件。

任务修订、任务所有者、已删除任务记录和保存的 Team 模式仍受支持。普通子代理发现与通信保持不变。Session 格式和已提交日志文件不变；投影检查点版本 7 从日志重建旧缓存状态。

## 迁移

1. 无需转换数据或修改配置。正常打开 Session 即可重建不兼容的投影检查点。
2. 使用 `list_agents` 和 `send_message` 与当前队友协作。需要归档信息时，从原始 Session 日志读取历史名册或邮箱事件；Team 投影不再提供这些集合。
3. 确认任务板和保存的 Team 模式已恢复。历史名册与邮箱记录不授予任务分配权限。
