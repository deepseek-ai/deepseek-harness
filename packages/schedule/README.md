---
description: "The schedule package group: Host-owned scheduled reminders and task management."
kind: "package-group"
---

# schedule/ — Host-owned reminders

English | [中文](README.zh.md)

## Summary

Create one-shot, fixed-rate, daily, weekly, or cron reminders for a conversation and keep them across Host restarts. Inspect active and inactive tasks without opening their original Sessions. Use Schedule for reminder creation and delivery, and the optional Tasks page for cross-Session inspection and confirmed deletion. Due reminders arrive as ordinary follow-up messages in the original conversation, not email, SMS, or push notifications.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose this package for persistent reminder management.

| Package | Role |
|---|---|
| [`schedule/`](schedule/README.md) | Host-owned reminder persistence, scheduling, inspection, and explicit deletion |

-----

<a id="related-documentation"></a>
## Related documentation

- [Schedule subsystem](../../docs/subsystems/schedule.md) — task records, latest receipts, timing, and delivery contracts.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-schedule) — the `schedule_create`/`schedule_list`/`schedule_update`/`schedule_delete` schemas the model receives.
- [Schedule user guide](../../docs/user/guide/schedule.md) — enable reminders and inspect active or inactive tasks.
- [Web task page and reminder catalog](../client/ui-schedule/README.md) — browser inspection of tasks and confirmed deletion.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
