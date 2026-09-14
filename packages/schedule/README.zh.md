---
description: "schedule 组地图：基于会话日志的会话本地持久提醒，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# schedule/ — 仅限会话内的提醒

[English](README.md) | 中文

## 概述

schedule 组让 agent（智能体）为当前会话创建、列出和取消提醒。提醒可以在延迟后、绝对时间或固定间隔触发；到期时，它们会作为普通消息进入该会话。提醒在重启后依然存在，但不会离开会话，也不会发送电子邮件、短信或推送通知。本组的包提供提醒管理与交付。可选的浏览器包显示当前提醒目录，并标记已知存在活动提醒的会话；这些标识反映缓存状态，可能落后于运行中的会话。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`schedule/`](schedule/README.zh.md) | 会话本地提醒：安排、列出并取消活动记录；发布供 header 目录与列表行标识读取的可选只读 projection；把到期提醒作为会话消息交付 | —（工具只注册在精确的 agent scope 中） |

-----

<a id="related-documentation"></a>
## 相关文档

- [仅限会话内的 Schedule 子系统](../../docs/subsystems/schedule.zh.md)——持久记录、转换、视图与交付约定。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-schedule)——模型接收的 `schedule_create`／`schedule_list`／`schedule_delete` schema。
- [Schedule 用户指南](../../docs/user/guide/schedule.zh.md)——挂载本包的官方配置路径。
- [Web Schedule 目录](../client/ui-schedule/README.zh.md)——活动记录的可选只读浏览器呈现。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
