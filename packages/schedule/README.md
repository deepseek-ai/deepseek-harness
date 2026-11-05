---
description: "The schedule package group: Host-owned scheduled tasks, reminders, and task management."
kind: "package-group"
---

# schedule/ — Host-owned scheduled tasks

English | [中文](README.zh.md)

## Summary

Create RFC 5545 recurring tasks that deliver to an existing Session or to a new one, and keep them across Host restarts. Inspect active, paused, and ended tasks without opening their target Sessions. An Agent uses the Schedule tools, and a user uses the sidebar Automation tasks page, to create, edit, pause, resume, and delete tasks; the Automation tasks page can also run a task now. Due tasks arrive as ordinary follow-up messages in their target Session, not email, SMS, or push notifications.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose this package for persistent scheduled task management.

| Package | Role |
|---|---|
| [`schedule/`](schedule/README.md) | Host-owned task persistence, scheduling, delivery targets, inspection, and explicit deletion |
| [`tool-schedule/`](tool-schedule/README.md) | Preset-scoped `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit` tools over the Host `ctx.schedule` service |

-----

<a id="related-documentation"></a>
## Related documentation

- [Schedule subsystem](../../docs/subsystems/schedule.md) — task records, recurrence rules, delivery targets, latest receipts, and delivery contracts.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-schedule) — the `schedule_create`/`schedule_list`/`schedule_view`/`schedule_edit` schemas a mounting preset contributes.
- [Schedule user guide](../../docs/user/guide/schedule.md) — create, inspect, run, edit, and delete scheduled tasks.
- [Automation tasks page](../client/ui-schedule/README.md) — the sidebar page that manages every Host task in the browser.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
