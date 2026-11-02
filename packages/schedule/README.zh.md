---
description: "schedule 包组：Host 拥有的计划任务、定时提醒与任务管理。"
kind: "package-group"
---

# schedule/ — Host 拥有的计划任务

[English](README.md) | 中文

## 概述

创建投递到已有 Session 或新 Session 的 RFC 5545 重复任务，并在 Host 重启后保留它们。无需打开目标 Session，即可查看活动、已暂停和已结束的任务。Agent（智能体）使用 Schedule 工具、用户使用侧栏自动化任务页面创建、修改、暂停、恢复和删除任务；自动化任务页面还可以立即运行任务。到期任务作为普通 follow-up 消息进入其目标 Session，而不是电子邮件、短信或推送通知。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

选择此包进行持久的计划任务管理。

| 包 | 职责 |
|---|---|
| [`schedule/`](schedule/README.zh.md) | Host 拥有的任务持久化、调度、投递目标、查询与显式删除 |
| [`tool-schedule/`](tool-schedule/README.zh.md) | 基于宿主 `ctx.schedule` 服务的 preset 级 `schedule_create`、`schedule_list`、`schedule_view` 和 `schedule_edit` 工具 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Schedule 子系统](../../docs/subsystems/schedule.zh.md)——任务记录、重复规则、投递目标、最近一次回执与投递约定。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-schedule)——挂载 preset 所贡献的 `schedule_create`／`schedule_list`／`schedule_view`／`schedule_edit` schema。
- [Schedule 用户指南](../../docs/user/guide/schedule.zh.md)——创建、查看、执行、修改和删除计划任务。
- [自动化任务页面](../client/ui-schedule/README.zh.md)——在浏览器中管理宿主所有任务的侧栏页面。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
