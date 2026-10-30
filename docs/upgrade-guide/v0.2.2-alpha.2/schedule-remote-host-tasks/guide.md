---
kind: upgrade-guide
description: "Schedule clients use one Host-wide management API and typed timing records; stored Host tasks keep the existing domain and layout."
---

# Schedule uses one Host-wide management API

English | [中文](guide.zh.md)

## Change

Schedule management addresses every Host task by id. The native and Remote APIs share one service; the previous Session-bound `delete` and `update` methods are removed. Native creation takes a typed `timing`, and catalog results discriminate After, At, Every, Daily, Weekly, Cron, and RRULE with `kind`.

The existing `schedule` domain writes version 2 and reads version 1 without startup writes, retaining its route, envelope, and layout. SQLite's physical schema stays at version 1. Back up the store before upgrading: the first successful v2 write stamps the unit v2, which a v1 binary refuses to open. Downgrade requires restoring that backup. Edits and delivery save current rows without a separate migration command. The plugin README owns the [stored schema, upgrade timing, and costs](../../../../packages/schedule/schedule/README.md#storage-format).

## Migration

1. Native callers use `create({ title, prompt, timing, target? }, actorSessionId?, signal?)` and `edit(request, actorSessionId?, signal?)`. Remote callers use `schedule/create` and `schedule/edit` with a `request` argument. Wrap a Cron selector as `{ kind: "cron", cron: { expression, time_zone } }`, or RRULE as `{ kind: "rrule", rrule }`. Model tool arguments continue to expose RRULE.
2. Replace Session-bound deletion with `edit({ id, action: "delete" })`; replace updates with `edit({ id, action: "update", patch, expectedUpdatedAt? })`. Timing edits use `patch.timing`. Supply the read revision, or `null` to compare an absent revision; handle `schedule_conflict` by rereading.
3. `list({ active?, limit?, offset? })` returns `{ items, shown, total, limit, offset }` across the Host. `catalog()` returns all tasks; `view({ id })`, `history({ id, limit, before? })`, and `run({ id })` need no owner Session. Read a reusable destination from `target`, and each receipt destination from `targetSessionId`.
4. Use the unprefixed types exported by the package root or `/client`, including `ScheduleRecord`, `ScheduleTiming`, and `ScheduleCatalogEntry`. Narrow by `kind` before reading timing fields. Handle `paused` and `ended` instead of `inactive`, and allow absent creation/change timestamps. The root helpers `scheduleView`, `decodeScheduleChange`, `foldScheduleEvents`, and `SCHEDULE_CHANGE_VERSION` are removed; historical event types remain frozen data declarations. The [tool upgrade guide](../schedule-agent-tools/guide.md) lists the removed types and their replacements.
5. Verify that Automation tasks shows existing Cron and calendar tasks and that a metadata edit preserves their timing and history. Historical Session-log reminders still require explicit recreation; they are outside this Host-task change.
