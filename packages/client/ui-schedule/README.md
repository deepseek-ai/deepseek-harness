---
description: "Automation task management and Session reminder entries in the existing Web UI."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-schedule

English | [中文](README.zh.md)

## Summary

The Automation tasks page and right Sidebar task tab use the same editor for task rules, saved delivery records, deletion, and conversation navigation. Manual creation and target selection use the Host Schedule service; conversation cards, header clocks, and Session row marks retain their existing locations.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Below 768px, the task list uses 20px horizontal insets, matching the Plugins page.

The shipped Web composition mounts `ui-schedule` with Host Schedule. The Automation tasks sidebar entry opens the task list without selecting or activating a Session. New and the adjacent menu's Create in a session action both open a new conversation with a short task-creation prompt in the current UI language, ready for the user to complete and send. When a blank conversation is reused, the prompt is appended on a new line, preserving its text, inline references, and attachments. The same menu offers Create manually. Manual creation opens the same editor as an existing task, validates required fields, and saves a task without starting an Agent or sending the instruction. A failed request leaves the form and its values visible. The empty state shows a decorative document-and-clock illustration whose colors follow the theme.

Enabled, Paused, Ended, and All filters combine with text search over the title, prompt, and linked Session id; the page starts on Enabled. The search-row menu clears all ended tasks after confirmation, preserving active and paused tasks. Selecting a task opens its editable Rules / Records page. Save is enabled only for valid, meaningful changes and sends only changed fields with `expectedUpdatedAt`, or `null` when no stored revision exists. The fields stay editable after saving. Unsaved drafts survive navigation between tasks and away from the page. A conflict retains the whole draft and disables Save. Review with my edits reapplies the changed field groups to the latest values for review before saving; Discard replaces the draft with the latest stored values. For a new task, Discard closes the editor. Late responses cannot change another task's detail. Coarse-pointer search, instruction, and timing fields use 16px text to prevent focus zoom on iOS Safari.

The destination menu offers a new conversation that the first delivery creates and later deliveries reuse, or a new conversation at every delivery. Manual creation defaults to reuse. A task already bound to a Session shows Current linked conversation as its destination, and editing it preserves that destination unless the user explicitly chooses a new one. The Linked workspace selector lists the framework Workspace catalog, shows each Workspace's directory under its name, and labels the first-use Workspace with its localized default name. A new destination starts in that Workspace, else in the first listed one. A stored task without a directory shows Ungrouped, because the Sessions it creates join no Workspace. For a reusable destination, the bottom conversation entry shows Pending creation until the first Session exists. A per-run destination instead shows Latest run conversation after its first delivery and hides the entry before that delivery; earlier conversations remain accessible from delivery records. Available links recheck membership and archive state before opening; missing or archived Sessions remain disabled.

The repeat editor offers once, minute, hour, day, week, month, and custom rules. Date and clock controls reuse existing pickers. Guided presets produce RRULE; minute and hour intervals start from the current minute in the selected zone. The Custom choice and Customize input do not name either syntax; the input accepts a two-line RRULE or a five-field Cron expression with an explicit zone. RRULE retains the zone in `DTSTART`; Cron retains its expression and selected zone as Cron timing. Complex RRULE values remain verbatim. The shared time parser checks new or changed Custom text before enabling Save; invalid or empty input keeps the draft and explains which field to change. Invalid Custom text offers manual correction, another repeat option, or correction by the Agent. The Host performs the final validation on save. Stored After and At tasks show date and clock fields immediately; a repeated local time uses UTC when needed to retain the exact instant. Every, Daily, and Weekly tasks show the matching controls when their interval or wall-clock precision is representable. Other stored timings remain in Custom and keep their typed timing until replaced. Viewing a task or editing other fields preserves its timing and committed occurrence.

Pause and resume update lifecycle state. Unsaved changes hold pause, resume, Run now, and Delete until you save or discard them. The detail menu offers Run now and Delete. It offers no queued-message cancellation: one inbox message may contain deliveries from several tasks. While a delivery to a reused conversation is queued or running, the detail disables its fields, Save, pause and resume, Run now, and Delete, and states that the task is queued or running and is managed in its conversation, which the bottom conversation entry opens. The minimum delivery interval disables another immediate run until the interval ends, while pause and deletion remain available once execution is idle. When the interval is the only cause, the Run now row stays focusable, and its tooltip states that the minimum run interval has not passed and when Run now becomes available. An archived linked conversation of a task already bound to a Session also disables Run now, because the Host refuses that delivery. A run that the Host refuses with `schedule_execution_pending` shows a status notice instead of an error. Deletion requires confirmation, removes the task and its saved records, retains Sessions and already-delivered messages, and reports the result through the existing app-wide toast. The confirmation focuses Cancel first; when it closes, focus returns to the detail menu button. The detail keeps the task until the Host answers. An applied deletion closes the detail or its task tab; a failed deletion keeps the task open for another attempt.

The list, detail, header, and Session hover show the later of the scheduled occurrence and the Host delivery floor as the next run. Creation and editing show one short minimum-interval hint for per-run conversation targets, read from `schedule.deliveryLimits`; a failed read offers Retry. Scheduled and immediate runs share this limit.

Records lazily requests 20 saved deliveries, supports newest-first pagination, retains loaded records after failure, and ignores superseded or unmounted requests. Each record shows its occurrence and saved prompt, with Expand / Collapse for long prompts; legacy records without prompt text never substitute the current instruction. A receipt's actual destination has a conversation link when the Session is available. Confirmed pruning is stated only after the final saved page and offers the current retention explanation. These records acknowledge inbox delivery, not model execution success.

An open conversation's header clock remains hidden before the first successful read or while no active related tasks exist. One task opens its right Sidebar tab; several open the existing popover. Idle, unarchived Session rows with active related tasks retain their clock mark and hover list. `schedule_create` continues to render a Turn-level card with a task title, repeat description, and Open action. Persisted legacy and current tool results both render; an authoritative read newer than the card resolves later edits or deletion.

### Time-zone data source

Time-zone enumeration and localized names use the browser's embedded ICU/CLDR data through `Intl`. There is no runtime download. The editor retains a stored alias even when enumeration omits it, and uses the system zone plus UTC when enumeration is unavailable.

<a id="understand-the-implementation"></a>
## Understand the implementation

Task menus use the [standard menu geometry](../../../docs/ui-radius.md#nested-hover), including keyboard-highlighted rows. Portaled task menus, date/time pickers, and the Session-header popover follow their triggers through CSS anchors, with layout-viewport limits and desktop frame clearance. Browser zoom and panning move these panels with the page; they may extend beyond the visual viewport, including while the keyboard is open. Labels ellipsize when they exceed the panel width. Clock columns and task-menu choices scroll vertically within the panel height limit. Horizontal gestures over clock columns can pan the zoomed page; vertical overscroll stays within the column. Outside dismissal and keyboard navigation remain available.

<details>
<summary>Implementation details — click to expand</summary>

While the Peer may read `schedule/catalog`, the plugin registers the existing `schedules` main panel, Session header utility, Turn tail card, Session row mark and hover entries, and `scheduleTask` right Sidebar tab. Slot injection supplies framework readers and action callbacks; components own selection, search, and paging state. Entry-declared stores retain each task draft and its CAS baseline across navigation within their root or Session scope; the main panel and Session tabs have independent drafts. Pristine forms follow the catalog. A dirty form retains all fields and its original revision. A newer catalog revision prevents saving until the user discards the draft or explicitly reapplies changed title, prompt, timing, and target groups to that revision. Reapplying does not write; the user reviews the resulting form and saves with the new CAS baseline. Untouched groups follow the newer record. Missing tasks retain editable local drafts while Host mutations stay disabled. Drafts are not persisted; a Client reload or disposal of the owning entry or Session scope drops them. The Host owns task storage and execution. Browsing catalogs does not activate a Session. Conflict feedback reuses the catalog notice style; its outlined review action wraps below the message in narrow panes.

Edits to typed calendar timing use the shared recurrence evaluator to find the first valid future occurrence while preserving interval alignment across daylight-saving gaps. Successful edits use Schedule’s existing [current-format write path](../../schedule/schedule/README.md); a content-only edit retains the timing kind, precision, expression, and committed occurrence.

The manager, task tabs, row marks, and conversation-header projections share one observable `schedule.catalog` source. Header and row views filter active records by involvement and delivery target. Mutations use task-id-based `schedule.create`, `schedule.edit`, and `schedule.run`; history uses task identity and cursor without a Session ownership parameter. A mutation acknowledgment triggers a fresh authoritative read; a failed read remains a catalog error rather than changing the acknowledged write into a failure.

Sidebar layout records omit opener parameters. `TaskTabBindings` therefore persists task identity by Session and tab id in localStorage, without storing task content. Closed tab bindings are pruned. Observable catalog requests subscribe only while read, invalidate on Schedule changes and connection reset, and retire outstanding reads after the final subscriber leaves.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Schedule](../../schedule/schedule/README.md) owns persistence, destinations, lifecycle, and delivery semantics.
- [Slots](../../../docs/subsystems/slots.md) defines framework readers and panel contributions.

<a id="model-experience"></a>
## Model Experience

None, as this browser package registers no model tools or automatic messages; the creation prompt stays an unsent draft.

#### KV Cache effect

None. Task-list content does not enter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Saved records describe inbox delivery, not execution results; absent historical prompts or physically deleted tasks cannot be reconstructed.
- The Host limits saved history by `deliveryHistoryDays` and `deliveryHistoryRecords`; page size limits record count, not prompt bytes.
- Conversation links open the Session through normal navigation, not a specific message. Deleting a task does not cancel messages already delivered.
- This UI provides no task-level authorization for model tools. Host Schedule owns access control and must enforce any per-Session restrictions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context — click to expand</summary>

None.

</details>
