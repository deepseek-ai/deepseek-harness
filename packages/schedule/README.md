---
description: "The schedule group map: session-local durable reminders over the session log, for users and maintainers navigating the group."
kind: "package-group"
---

# schedule/ — Session-local reminders

English | [中文](README.zh.md)

## Summary

The schedule group lets an agent create, list, and cancel reminders for the current conversation. Reminders can run after a delay, at an absolute time, or on a fixed interval; when due, they arrive as ordinary messages in that conversation. They survive restarts, but never leave the session or send email, SMS, or push notifications. The group's package provides reminder management and delivery. Optional browser packages show the current reminder catalog and mark conversations with known active reminders; those indicators reflect cached state and may lag the running session.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`schedule/`](schedule/README.md) | Session-local reminders: schedule, list, and cancel active records; publish an optional read-only projection for the header catalog and list-row marker; deliver due reminders as conversation messages | — (tools only, in the exact agent scope) |

-----

<a id="related-documentation"></a>
## Related documentation

- [Session-local Schedule subsystem](../../docs/subsystems/schedule.md) — durable record, transition, view, and delivery contracts.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-schedule) — the `schedule_create`/`schedule_list`/`schedule_delete` schemas the model receives.
- [Schedule user guide](../../docs/user/guide/schedule.md) — the official configuration path for mounting the package.
- [Web Schedule catalog](../client/ui-schedule/README.md) — the optional read-only browser presentation of active records.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
