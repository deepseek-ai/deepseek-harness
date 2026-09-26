---
description: "schedule 包组：Host 拥有的定时提醒与任务管理。"
kind: "package-group"
---

# schedule/ — Host 拥有的提醒

[English](README.md) | 中文

## 概述

为对话创建一次性、固定速率、每日、每周或 cron 提醒，并在 Host 重启后保留它们。无需打开原 Session，即可查看活动和已结束任务。使用 Schedule 创建和投递提醒，使用可选的任务页面跨 Session 查看任务并确认删除。到期提醒作为普通 follow-up 消息进入原对话，而不是电子邮件、短信或推送通知。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

选择此包进行持久提醒管理。

| 包 | 职责 |
|---|---|
| [`schedule/`](schedule/README.zh.md) | Host 拥有的提醒持久化、调度、查询与显式删除 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Schedule 子系统](../../docs/subsystems/schedule.zh.md)——任务记录、最近一次回执、时间与投递约定。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-schedule)——模型接收的 `schedule_create`／`schedule_list`／`schedule_update`／`schedule_delete` schema。
- [Schedule 用户指南](../../docs/user/guide/schedule.zh.md)——启用提醒并查看活动或已结束任务。
- [Web 任务页面与提醒目录](../client/ui-schedule/README.zh.md)——在浏览器中查询任务并确认删除。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
