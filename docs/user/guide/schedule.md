# Schedule reminders

English | [中文](schedule.zh.md)

## Summary

Create reminders in a conversation, then inspect active and inactive tasks and edit an active task's name, instruction, and run time from the Automation tasks page. Daily reminders follow a saved local time and time zone; fixed-rate reminders follow elapsed intervals. Delivered one-shot tasks remain available until you explicitly delete them.

## Table of Contents

- [Create reminders](#create-reminders)
- [Inspect and delete tasks](#manage-tasks)
- [Edit an active task](#edit-timing)
- [Timing and delivery reference](#timing-and-delivery)
- [Further Exploration](#further-exploration)

<a id="create-reminders"></a>
## Create reminders

The shipped Web profile does not include Schedule. Open Plugins and enable Automation tasks in the Official group; the optional experimental bundle `@deepseek-ai/dsh-experimental-schedule-bundle` then adds Schedule with the clock context that gives the model the current time and the browser's zone. Configure a model provider before asking it to create reminders.

Ask the model to create, list, edit, or delete reminders. It uses `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` (update changes one reminder in place and keeps its id and saved delivery records); the Automation tasks page's New action opens a New Session for a creation instead, with the request already written in its composer. Supported choices are a one-time delay in positive whole seconds, an absolute date and time, a fixed interval of at least one minute, a daily local time with an IANA time zone, a weekly local time with an IANA time zone and ISO weekdays from Monday 1 through Sunday 7, or a five-field cron expression with an explicit IANA time zone, stored in canonical form.

For example, ask: “Remind me every day at 23:00 in Asia/Shanghai to check the weather.” Open Automation tasks and select the created reminder. Check that its frequency shows a daily rule and the requested zone, not Once. A one-time reminder does not become recurring after delivery.

<a id="manage-tasks"></a>
## Inspect and delete tasks

Open Automation tasks from the sidebar to view reminders across Sessions without activating their conversations. Search by the stored task name, the instruction, or the task's internal Session id, and filter by the single All, Enabled, or Inactive status row. An idle, unarchived Session row whose Session has at least one active task shows a clock mark; an archived row keeps that cell blank, with its live status on the hover card only. A long hover on a Session row with active tasks lists up to two of those tasks with their frequency and their next run as a device-zone time with its relative duration. The open Session's header shows an icon-only reminder clock while active reminders exist: it opens the sole task's details directly, or a list of the Session's reminders otherwise.

Select a task to open Rules, then choose Delivery records to load the newest 20 saved records. Each saved record reads as one compact row: a clock glyph, the occurrence time in the task's saved zone (the browser's zone for a one-shot or interval task), and the saved instruction when one was stored. Records without a saved instruction never show the current instruction in its place. Load older records adds the next page. Records follow newest-first saved order even if the clock moves backward; they do not describe model execution results. The original Session entry sits in the detail tab strip, so it stays visible while the Rules view scrolls. Unmodified Left/Right arrows and Home/End switch the focused tabs; Alt, Ctrl, Meta, and Shift combinations are not intercepted. Refreshing the task preserves the selected tab.

An empty record view means a successful query returned no saved records. Loading, request failure, a missing task, and an invalid older-record cursor have separate messages. Use Retry delivery records after a failed request or missing-task response; use Refresh delivery records after an invalid cursor to reload the newest page. Previously loaded records may remain visible with a warning while a request fails. A new latest delivery refreshes the newest page. Late responses for a task or view you have left do not replace the current view.

For tasks without saved history, only an existing latest receipt can be shown until new deliveries add records; later deliveries do not recover the missing history or clear its notice. Unsaved earlier records and instruction snapshots cannot be recovered, and the current instruction is not substituted for a missing saved instruction. The earlier-history notice appears only when the Host marks earlier records unavailable; new tasks with no deliveries show the empty state without that notice.

Active tasks participate in scheduling. Inactive tasks do not schedule another delivery. A one-time task becomes inactive after its reminder is durably written to the conversation inbox; choose All tasks or Inactive to find it. The conversation-header catalog and model `schedule_list` show only active reminders, so disappearance from those views does not mean the retained task was deleted.

The Linked session entry in the detail tab strip opens the original conversation when its metadata is ready and the Session is available and unarchived. Otherwise the entry is disabled with a reason. The task details and deletion action remain available even when its original Session cannot open. Browsing tasks does not unarchive Sessions.

Choose Delete task and confirm to stop future delivery and remove the task from the list, including for an inactive task. Deletion removes the task together with its saved delivery records, so the task's saved history is gone. Confirming the deletion closes the panel or tab that asked for it and reports the outcome in one app-wide notice — deleted, or a failure that leaves the task in place to retry; it does not remove the original conversation or retract a message already queued there. The row stays visible until a successful query confirms the remaining tasks. If a query fails, Retry reloads the catalog; the error is not an empty successful result.

<a id="edit-timing"></a>
## Edit an active task

In Automation tasks, select an active task and open Rules to edit its name, instruction, and run time. Inactive tasks are read-only, and edits stay in a local draft until you choose Save changes. Editing keeps the task id, original conversation, latest delivery receipt, and all saved delivery records.

- Daily and Weekly: edit Time and Time zone; a weekly rule also toggles Weekday. A clock row shows whole seconds, an untouched row keeps a stored millisecond value for its submit, and the stored IANA zone is kept. A changed rule selects its first future occurrence using the DST rules below.
- Every: choose Every N hours, Every N minutes, or Every N seconds and enter the quantity in the unit the row states; the smallest accepted interval is 1 hour, 1 minute, or 60 seconds for that unit, and the submitted interval is whole seconds. A changed interval starts from the Host's accepted-save time, with the first target one new interval later. Time zones do not affect this elapsed interval.
- One-shot After/At: edit separate Date and Time rows and Time zone. The initial zone is the record's stored zone, or this device's zone when the record stores none, and the seeded clock names the same stored instant; a one-shot rule that stored no zone shows one hint stating that the selected zone interprets the entered date and time. Changing the zone keeps those clock values and changes the instant. A changed target saves as At with the same task id. The zone is not retained as recurrence metadata.

The rows change only a local draft. Save changes submits the name, instruction, and the complete rule in one update, and a save bar appears while the draft differs from the stored task; Cancel restores the stored values. The Repeat menu offers Weekly, Monday to Friday, Every day, Every N hours, Every N minutes, Every N seconds, Once, and Custom (cron), and the Host accepts any of them, so a one-shot After may save as At. An equivalent normalized rule performs no write or target reset: the same Every interval does not restart its timing, and an unchanged one-shot target preserves After or At. The rows are disabled while a save is in flight. Leaving the card does not roll back a Host write already begun.

A catalog refresh keeps the fields you have edited and takes every other field from the refreshed record, so a concurrent change to another field survives an unsaved edit. Invalid input is reported and blocks Save. If delivery or another edit changed the task, a conflict prevents overwriting that change; retry to edit the latest rule. An accepted update refreshes the catalog. A rejected or unconfirmed update is distinct from a catalog-loading error: use Retry to reload the catalog, not to repeat an acknowledged update. If the update itself cannot be confirmed, check the task before retrying. Late responses after closing details or switching tasks do not replace the current view.

<a id="timing-and-delivery"></a>
## Timing and delivery reference

Reminders remain stored when their Session is not open. While the Host runs, it restores the original Session when a reminder becomes due and queues a follow-up without interrupting current work. Restarting checks stored tasks and sends an overdue one-shot or only the latest missed occurrence of each recurring task. Closing the Host stops scheduling until it starts again. Due recurring tasks for the same Session can share one message.

Fixed-rate reminders stay aligned to creation until their interval changes; a changed interval aligns to the accepted-save time. Daily reminders instead follow the saved local time and IANA zone. A daily local time or date that does not exist is skipped; an overlapping time uses the earlier instant once that day. An absolute-time request rejects a nonexistent local time and chooses the earlier instant during an overlap. The browser supplies its zone for interpreting natural-language requests; naming a zone explicitly avoids ambiguity. Task details keep a saved wall-clock rule's zone in its frequency text and show every next target as a device-zone clock; a one-shot task stores only the UTC instant, so its timestamps use the browser's zone.

Saved delivery records confirm messages persisted in the conversation inbox, not that the model completed the requested work. Failed inbox persistence or task writes add no saved record. A crash or task-write failure after inbox persistence can leave a delivered message unrecorded and repeat a delivery; exactly-once delivery is not guaranteed. This is not an execution history or an external notification channel.

Saved records are pruned when an acknowledgment is appended: the Host keeps the records whose acknowledgment time falls inside the configured `deliveryHistoryDays` window, measured back from the appended receipt's `deliveredAt`, and at most the newest `deliveryHistoryRecords` records. The latest receipt always survives, and a pruned window marks earlier records unavailable. The Host keeps the retained history in memory and rewrites the full task row for each acknowledgment. Pagination limits returned record count, not the retained history or instruction bytes.

Pause and a new Session for each run are not supported. Name, instruction, and run-time editing is available to the model through `schedule_update`, which changes the reminder in place and keeps its id and saved delivery records, and to the Automation tasks page against the selected task's binding; neither is a cross-Session relay workflow. Reminders recorded only in an older Session log are not scheduled automatically; recreate the ones you still need. Previously deleted task records are not reconstructed.

<a id="further-exploration"></a>
## Further Exploration

- [Schedule reference](../../../packages/schedule/schedule/README.md) documents exact timing selectors, persistence, and delivery limits.
- [Automation tasks page reference](../../../packages/client/ui-schedule/README.md) describes the global page and conversation-header catalog.

## Dev Note

None.
