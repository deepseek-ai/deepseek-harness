---
kind: upgrade-guide
description: "The Schedule model tools become `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit` over every Host task, and `schedule_update` and `schedule_delete` are removed."
---

# Schedule tools manage every Host task by RRULE and target

English | [中文](guide.zh.md)

## Change

Earlier, `@deepseek-ai/dsh-tool-schedule` registered `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete`. They managed only the reminders of the calling Session, and `schedule_create` took one timing selector: `after_seconds`, `at`, `every_seconds`, `daily`, `weekly`, or `cron`.

The package now registers `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit`:

- `schedule_create` takes `title`, `prompt`, `rrule` (one `DTSTART` line and one `RRULE` line), and `target` (`this_session`, `new_once`, or `new`). It accepts no timing selector.
- `schedule_list` returns one page `{ items, shown, total, limit, offset }` of active, paused, and ended tasks instead of an array of active reminders.
- `schedule_view` reads one task by id.
- `schedule_edit` with `action: "update"` replaces `schedule_update` and can also change `rrule` and `target` or pause and resume a task; `action: "delete"` replaces `schedule_delete`.
- Each tool reads, changes, and deletes any Host task by id, not only the tasks of the calling Session.
- A call from a delegated subagent returns `subagent_session` with the message `A delegated subagent cannot use scheduled tasks.`

Existing reminders keep their timing and delivery. Recorded Sessions keep their earlier calls and results, and the Web transcript still renders them.

This affects:

- prompts, skills, and scripts that tell a model to call `schedule_update`, `schedule_delete`, or a timing selector;
- deployments that rely on each Session seeing only its own reminders;
- TypeScript code that imports `scheduleView` from the root entry, or `ScheduleView`, `ScheduleState`, `ScheduleDeliveryMode`, `ScheduleCreateValue`, `ScheduleListValue`, `ScheduleDeleteRequest`, `ScheduleDeleteValue`, `ScheduleTimingChange`, `ScheduleUpdateContent`, `ScheduleUpdateMiss`, `ScheduleUpdateRequest`, `ScheduleUpdateResult`, or `ScheduleUpdateValue` from the root or `/client` entry of `@deepseek-ai/dsh-schedule`.

## Migration

1. In prompts, skills, and scripts, replace `schedule_update` and `schedule_delete` with `schedule_edit`, replace each timing selector with an RRULE, and supply the required `target` on creation. For example, `daily: { time: "09:00:00", time_zone: "Asia/Shanghai" }` becomes `rrule: "DTSTART;TZID=Asia/Shanghai:20261013T090000\nRRULE:FREQ=DAILY"`; use `target: "this_session"` to keep delivery in the calling Session.
2. If the agents of a preset must not manage the tasks of other Sessions, remove the `@deepseek-ai/dsh-tool-schedule` row from that preset.
3. In TypeScript code, use `ScheduleCreateRequest`, `ScheduleTiming`, `SchedulePatch`, and `ScheduleEditRequest` for writes, and `ScheduleViewResult`, `ScheduleListResult`, and `ScheduleEditResult` for reads and edits. Call `ScheduleService.view`, paged `list`, and `edit` instead of `scheduleView`, `update`, and `delete`. `ScheduleDeleteResult`, `ScheduleDeleteChange`, and `ScheduleDeleteInactiveResult` remain exported from the root and `/client`; the old request/value types above do not. The [Schedule service README](../../../../packages/schedule/schedule/README.md) describes these APIs.
4. Custom compositions must provide both `tools` and `systemPrompt` before mounting this consumer; registration also waits for `schedule`. The `tool:schedule` section supplies the shared authorization instruction. A `complete: true` prompt override must include that instruction itself.
5. Open a Session under each changed preset and confirm that its tool list shows the four tool names. Delegate a task and confirm that a Schedule tool call from the child returns `subagent_session`; the child's tool list includes the four names, as [Configure subagent composition through presets](../../v0.2.1-alpha.1/subagent-preset-composition/guide.md) describes.
