---
kind: upgrade-guide
description: "Schedule 的模型工具改为面向宿主全部任务的 `schedule_create`、`schedule_list`、`schedule_view` 与 `schedule_edit`，并移除 `schedule_update` 与 `schedule_delete`。"
---

# Schedule 工具按 RRULE 与目标管理宿主的全部任务

[English](guide.md) | 中文

## 变更

较早时，`@deepseek-ai/dsh-tool-schedule` 注册 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete`。它们只管理调用方 Session 的提醒，`schedule_create` 接受一个时间选择参数：`after_seconds`、`at`、`every_seconds`、`daily`、`weekly` 或 `cron`。

现在本包注册 `schedule_create`、`schedule_list`、`schedule_view` 与 `schedule_edit`：

- `schedule_create` 接受 `title`、`prompt`、`rrule`（一行 `DTSTART` 与一行 `RRULE`）和 `target`（`this_session`、`new_once` 或 `new`）。它不接受任何时间选择参数。
- `schedule_list` 返回一页 `{ items, shown, total, limit, offset }`，包含活动、暂停与已结束的任务，而不是活动提醒的数组。
- `schedule_view` 按 id 读取一个任务。
- 带 `action: "update"` 的 `schedule_edit` 取代 `schedule_update`，并且还能改变 `rrule` 与 `target`，或暂停与恢复任务；`action: "delete"` 取代 `schedule_delete`。
- 每个工具都按 id 读取、改变和删除宿主的任意任务，而不只是调用方 Session 的任务。
- 被委派的子 agent 发起的调用返回 `subagent_session`，消息为 `A delegated subagent cannot use scheduled tasks.`

已有提醒保留其时间规则与投递方式。已录制的 Session 保留较早的调用与结果，Web transcript 仍会渲染它们。

受影响的对象：

- 让模型调用 `schedule_update`、`schedule_delete` 或某个时间选择参数的提示词、skill 与脚本；
- 依赖“每个 Session 只看到自己的提醒”的部署；
- 从 `@deepseek-ai/dsh-schedule` 根入口导入 `scheduleView`，或从根入口或 `/client` 入口导入 `ScheduleView`、`ScheduleState`、`ScheduleDeliveryMode`、`ScheduleCreateValue`、`ScheduleListValue`、`ScheduleDeleteRequest`、`ScheduleDeleteValue`、`ScheduleTimingChange`、`ScheduleUpdateContent`、`ScheduleUpdateMiss`、`ScheduleUpdateRequest`、`ScheduleUpdateResult` 或 `ScheduleUpdateValue` 的 TypeScript 代码。

## 迁移

1. 在提示词、skill 与脚本中，把 `schedule_update` 与 `schedule_delete` 替换为 `schedule_edit`，把每个时间选择参数替换为 RRULE，并在创建时提供必填的 `target`。例如，`daily: { time: "09:00:00", time_zone: "Asia/Shanghai" }` 变为 `rrule: "DTSTART;TZID=Asia/Shanghai:20261013T090000\nRRULE:FREQ=DAILY"`；使用 `target: "this_session"` 将投递保留在调用方 Session。
2. 如果某个 preset 的 agent 不应管理其他 Session 的任务，从该 preset 中移除 `@deepseek-ai/dsh-tool-schedule` 这一行。
3. 在 TypeScript 代码中，写入使用 `ScheduleCreateRequest`、`ScheduleTiming`、`SchedulePatch` 和 `ScheduleEditRequest`，读取与编辑结果使用 `ScheduleViewResult`、`ScheduleListResult` 和 `ScheduleEditResult`。调用 `ScheduleService.view`、分页的 `list` 和 `edit`，替换 `scheduleView`、`update` 和 `delete`。根入口与 `/client` 仍导出 `ScheduleDeleteResult`、`ScheduleDeleteChange` 和 `ScheduleDeleteInactiveResult`，但不再导出上述旧请求／结果值类型。[Schedule 服务 README](../../../../packages/schedule/schedule/README.zh.md) 描述了这些 API。
4. 自定义组合须先提供 `tools` 和 `systemPrompt`，再挂载此消费者；注册还会等待 `schedule`。`tool:schedule` 区段提供共用授权指令。使用 `complete: true` 的提示词覆盖时，须自行保留该指令。
5. 在每个改动过的 preset 下打开一个 Session，确认其工具列表显示这四个工具名。委派一个任务，确认子 agent 调用 Schedule 工具时返回 `subagent_session`；子 agent 的工具列表包含这四个工具名，详见[通过 preset 配置子 Agent 组装](../../v0.2.1-alpha.1/subagent-preset-composition/guide.zh.md)。
