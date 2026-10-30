# Schedule reminders

English | [中文](schedule.zh.md)

## Summary

Ask the model in a conversation to create, list, view, edit, pause, resume, or delete reminders. Each reminder repeats by its rule and delivers its instruction to an existing conversation, to one new conversation, or to a new conversation at every occurrence. The Automation tasks page lists every reminder of the Host and can create, edit, run, pause, resume, and delete one. Delivered one-shot tasks remain available until you explicitly delete them.

## Table of Contents

- [Create reminders](#create-reminders)
- [Inspect, run, and delete tasks](#manage-tasks)
- [Edit a task](#edit-timing)
- [Timing and delivery reference](#timing-and-delivery)
- [Further Exploration](#further-exploration)

<a id="create-reminders"></a>
## Create reminders

The shipped Web profile includes the Host Schedule service and the Automation tasks page. Configure a model provider before asking it to create reminders.

The `standard`, `cordis`, and `ptc` presets declare the four reminder tools and the clock context that gives the model the current time and the browser's zone, so those presets provide `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit`; the `minimal` preset declares neither. A delegated subagent sees the four tools, but each tool refuses a call from a delegated subagent, so a subagent cannot read or change reminders.

Ask the model to create, list, view, edit, pause, resume, or delete reminders. It uses `schedule_create` to create one, `schedule_list` to list the reminders of every conversation, `schedule_view` to read one, and `schedule_edit` to change, pause, resume, or delete one; an edit keeps the reminder id and saved delivery records. A reminder that the model creates has a name, an instruction, a start time in UTC or in an IANA time zone, and an RFC 5545 repeat rule, such as every weekday at 09:00 or only once. It delivers to this conversation, to one new conversation that its first delivery creates, or to a new conversation at every delivery; a new conversation uses the working directory and preset of this conversation. Each delivery of a reminder comes at least one minute after the scheduled time of the previous delivery, or after the previous Run now; a reminder that opens a new conversation at every delivery waits for the Host's minimum run interval instead, one minute by default. A late delivery, for example after a Host restart, does not delay the next one.

A conversation that a delivery creates joins the Workspace registered at its working directory and takes the reminder name as its title. For a reminder that opens a new conversation at every delivery, the title also states the launch time in the zone of the reminder's rule, for example `Weekday digest · 2026-10-12 09:00`.

For example, ask: “Remind me every day at 23:00 in Asia/Shanghai to check the weather.” Below the reply, a card shows the created reminder's name and frequency; Open shows its details in the right sidebar. Check that the frequency repeats every day at 23:00, not Once. A one-time reminder does not become recurring after delivery. After the reminder is deleted, the card shows Deleted and no longer opens it.

To create a reminder without the model, open Automation tasks from the sidebar, open Choose a creation method beside New, and choose Create manually; when no task exists, New automation task opens the same dialog. The Create manually dialog asks for an Automation task name, an Automation task instruction, Run in, Linked workspace, and Run time. It starts with Once at one hour from now in the browser's time zone and with Create a conversation and reuse it. Run in offers Create a conversation and reuse it, which creates one conversation at the first run and keeps using it, and New conversation for every run, which creates a separate conversation at each run and shows the Host's minimum run interval. Linked workspace lists each registered Workspace with its directory and selects the Workspace whose directory the new conversation uses; it starts at Default workspace, or at the first Workspace when the default Workspace is not registered. When no Workspace exists, Linked workspace shows Ungrouped and the Host project directory is used. The new conversation uses the default preset. Create creates the task and selects it in the list, and Cancel closes the dialog without creating one. If the Host refuses the task, the dialog keeps your input and states the problem, for example that the date and time must be in the future.

New, and Create in a conversation in the same menu, open a new conversation in the current or most recent Workspace; ask the model there to create the task.

<a id="manage-tasks"></a>
## Inspect, run, and delete tasks

Ask the model to list reminders to see the reminders of every conversation, active ones first, or to show, pause, resume, or delete one reminder by its id.

Open Automation tasks from the sidebar to view reminders across Sessions without activating their conversations. Search by the task name, the instruction, or the id of the task's conversation, and filter by Task status: All, Enabled, Paused, or Ended. Rows are ordered by their scheduled time, earliest first. Each row shows the task name and one summary line: the status of a paused or ended task, the frequency, and, for an enabled task, Next scheduled time with its local and relative time.

A Session's tasks are the tasks that deliver to it, including the latest run of a task that creates a new conversation for every run, and the tasks that its Agent created or edited. An idle, unarchived Session row whose Session has at least one active task shows a clock mark; an archived row keeps that cell blank, with its live status on the hover card only. A long hover on a Session row with active tasks lists up to two of those tasks with their frequency and their next run as a device-zone time with its relative duration. The open Session's header shows an icon-only reminder clock while the Session has active tasks: it opens the sole task's details in the right sidebar, or otherwise a list of those tasks in which each row opens the task's details or deletes the task.

Select a task to open its details. Rules shows the task name, Next run with its local and relative time or the status of a paused or ended task, the instruction, Repeat, and Run in, which shows Current linked conversation for a task that delivers to an existing conversation. The bottom of the details shows Linked session, or Latest run conversation for a task that creates a new conversation for every run. Its button opens that conversation when the Session is available and unarchived, and is disabled otherwise; before the first run creates the conversation, the entry shows Pending creation. For a task that delivers to an existing conversation, Rules states when that conversation is archived, unavailable, or still loading. The task details and deletion remain available even when a conversation cannot open. Browsing tasks does not unarchive Sessions.

Choose Records to load the newest 20 saved records. Each record shows the occurrence time in the zone of the task's rule (the browser's zone when the rule names none), a button that opens the conversation that received the delivery when that conversation is available, and the saved instruction; Expand shows a long instruction in full. Records without a saved instruction never show the current instruction in its place. Load more adds the next page. Records follow newest-first saved order even if the clock moves backward; they do not describe model execution results. Left/Right arrows and Home/End switch the focused tabs.

An empty record view means a successful query returned no saved records. Loading, request failure, a missing task, and an invalid older-record cursor have separate messages. Use Retry after a failed request or missing-task response; use Refresh after an invalid cursor to reload the newest page. Previously loaded records may remain visible with a warning while a request fails. A new latest delivery refreshes the newest page. Late responses for a task or view you have left do not replace the current view.

When retention removed earlier records, the last page states that earlier delivery records have been cleared, and Retention rules shows how many records and how many days each task keeps. An older task without saved history shows only its latest delivery, without an instruction, until new deliveries add records. Unsaved earlier records and instruction snapshots cannot be recovered.

Active tasks participate in scheduling. Paused and ended tasks do not schedule another delivery. A one-time task ends after its reminder is durably written to the conversation inbox, and a repeating task ends after the last occurrence of its rule; choose All or Ended in Task status to find an ended task. The Session header clock, the row mark, and the hover card show only active tasks, so disappearance from those views does not mean that the task was deleted.

Pause in the details stops the future deliveries of an active task, and Resume restarts a paused task. Run now, in the Automation task actions menu, asks the Host to deliver the instruction once now and keeps the next scheduled run, also for a paused or ended task. While a delivery of a task that delivers to an existing conversation or to one new conversation is queued or running, Edit, Pause, Resume, Run now, and Delete task are disabled, and the details state that the task is queued or running and that you manage it in its conversation, which the button at the bottom of the details opens. A task that creates a new conversation for every run is not disabled this way; its runs continue beside one another. After a delivery, Run now stays disabled until the task's minimum delivery interval ends; while only the interval holds it, hold the pointer on Run now or move the keyboard to it to see when it becomes available. If the Host refuses a run for one of these reasons, the details state that the task is queued, running, or was just delivered. Run now is also disabled while the conversation that the task delivers to is archived. If you stop the conversation while the task's instruction waits there, the instruction stays queued until your next message, the task's next scheduled run, or Run now starts it.

Choose Delete task from the Automation task actions menu and confirm to stop future delivery and remove the task from the list, including for a paused or ended task. Deletion removes the task together with its saved delivery records, so the task's saved history is gone. Confirming the deletion reports the outcome in one app-wide notice — deleted, which also closes the details, or a failure that leaves the task in place to retry; it does not remove the conversations or retract a message already queued there. The row stays visible until a successful query confirms the remaining tasks. If a query fails, Retry reloads the catalog; the error is not an empty successful result.

<a id="edit-timing"></a>
## Edit a task

Ask the model to change a reminder's name, instruction, repeat rule, or delivery target, or to pause or resume it; the change keeps the reminder id and saved delivery records.

In Automation tasks, select a task and choose Edit to change its Automation task name, Automation task instruction, Run in, Linked workspace, and Run time, including for a paused or ended task. Edits stay in a local draft until you choose Save changes. Editing keeps the task id, latest delivery receipt, and all saved delivery records. A changed rule makes an ended task active again and keeps a paused task paused. For a task that delivers to an existing conversation, Run in shows Current linked conversation; choosing another option makes later runs create their conversations and sets Linked workspace to its starting value, as in Create manually. A task keeps its stored preset while its Workspace stays the same; a changed Workspace uses the default preset.

- Once: Date opens a month calendar, Time opens Hour, Minute, and Second columns, and Time zone interprets them. The task runs once and then ends.
- Every N minutes and Every N hours: Interval sets the number of minutes or hours, at least 1. The interval counts from the minute at which you save the task.
- Every day: Interval sets the number of days, and Time opens Hour and Minute columns.
- Weekly and Monday to Friday: Interval sets the number of weeks, Weekday selects the days, and Time opens Hour, Minute, and Second columns. Monday to Friday selects those five days at once.
- Monthly: Interval sets the number of months, Day of the month selects a date from 1 through 31, and Time opens Hour, Minute, and Second columns. A month without the selected date runs on its last day.
- Custom: Custom rule holds the rule text. A rule that the other choices cannot reproduce opens in Custom. An existing task without editable rule text shows its original frequency and keeps that timing until you save a replacement.

Time zone lists recently selected zones first, marks the system zone, and searches by UTC offset, IANA ID, or city. It appears for guided choices and Custom expressions that use a separate zone; otherwise the Custom rule text supplies its zone.

The fields change only a local draft. While you edit, the bottom of the details shows Unsaved changes with Cancel and Save changes; Save changes sends only the changed fields in one update, and Cancel restores the stored values. A save sends a new rule only when the timing changed. Save changes stays disabled while the name or instruction is empty or a guided choice is incomplete. The Host validates a supplied Custom rule on save; invalid text keeps the draft and shows an error. The fields are disabled while a save is in flight. Leaving the details does not roll back a Host write already begun.

A catalog refresh does not change the draft. If delivery or another edit changed the task before the save arrives, the Host refuses the save and changes nothing; the details state that the task changed elsewhere, Load latest version replaces the draft with the latest version, and Save changes stays disabled until then. If another save fails, the draft stays and the details ask you to try again; check the task before retrying an update whose outcome is unknown. An accepted update refreshes the catalog. Late responses after closing details or switching tasks do not replace the current view.

<a id="timing-and-delivery"></a>
## Timing and delivery reference

Reminders remain stored when their Session is not open. While the Host runs, it restores or creates the target Session when a reminder becomes due and queues a follow-up without interrupting current work. Restarting checks stored tasks and sends an overdue one-shot or only the latest missed occurrence of each recurring task. Closing the Host stops scheduling until it starts again. Due recurring tasks for the same Session can share one message.

A repeat rule in an IANA zone follows local wall time: it skips a local time that does not exist and uses the earlier instant of a repeated local time. Existing tasks keep their timing until you save a new rule: a fixed-rate reminder stays aligned to its creation time, and a daily, weekly, or cron reminder follows its saved local times in its IANA zone. The browser supplies its zone for interpreting natural-language requests; naming a zone explicitly avoids ambiguity. The Automation tasks page shows every next run as a browser-zone clock, and the frequency text names a rule's zone when it differs from the browser's zone; a rule that names no zone uses the browser's zone.

Saved delivery records confirm messages persisted in the conversation inbox, not that the model completed the requested work. Failed inbox persistence or task writes add no saved record. A crash or task-write failure after inbox persistence can leave a delivered message unrecorded and repeat a delivery; exactly-once delivery is not guaranteed. Closing the Host discards each message that still waits in a conversation inbox: its saved record remains, the model never receives that message, and the Host does not send it again. This is not an execution history or an external notification channel.

Saved records are pruned when an acknowledgment is appended: the Host keeps the records whose acknowledgment time falls inside the configured `deliveryHistoryDays` window, measured back from the appended receipt's `deliveredAt`, and at most the newest `deliveryHistoryRecords` records. The latest receipt always survives, and a pruned window marks earlier records unavailable. The Host keeps the retained history in memory and rewrites the full task row for each acknowledgment. Pagination limits returned record count, not the retained history or instruction bytes.

Name, instruction, timing, and target editing, pausing, and resuming are available to the model through `schedule_edit` and to the Automation tasks page for every reminder; neither is a cross-Session relay workflow. A change adds a notice to the next model request of each involved conversation whose Agent is loaded, except the conversation that made the change. Reminders recorded only in an older Session log are not scheduled automatically; recreate the ones you still need. Previously deleted task records are not reconstructed.

<a id="further-exploration"></a>
## Further Exploration

- [Schedule reference](../../../packages/schedule/schedule/README.md) documents task fields, delivery targets, recurrence rules, persistence, and delivery limits.
- [Automation tasks page reference](../../../packages/client/ui-schedule/README.md) describes the global page and conversation-header catalog.

## Dev Note

None.
