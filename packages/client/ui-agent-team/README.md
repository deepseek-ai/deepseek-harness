---
description: "Inspect the shared task board in the Web Session panel's Shared tasks section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds the Shared tasks section to the Session panel, between Subagents and Background jobs. Host projection frames keep task state current without a refresh control. Ordinary subagent navigation owns the member list and teammate conversations. The Web bundle loads this package; it adds no model-facing input.

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

In the root conversation’s model and reasoning menu, select **Agent teamwork** to open its settings pane, then turn on **Enable agent teamwork**. The root row shows the saved On/Off state without changing it; the state and its 12px chevron share the same foreground color. The settings pane shows the switch above the shared-task coordination, complex-task results, and token-cost explanation as ordinary text that describes the switch, without an information tooltip. Opening the pane focuses the enabled switch. New Sessions default to off. While enabled, open the root conversation’s Session panel to see members in the Subagents section and tasks in the Shared tasks section below it. Child conversations keep subagent navigation without a Team switch, including before their subagent address is discovered. The board reads the current Session’s `agentTeam` projection, so it appears only in a Session whose own projection is enabled. The Shared tasks section lists the tasks in progress first, then the pending ones, each in source order, then the completed ones with the latest in source order first, since a task carries no completion time. It shows five tasks and then the Session panel's fold control, “Show {count} more”, which shows the rest and then reads “Show less”; the list folds only when that holds back two tasks or more, and the choice holds for the Session, also after the panel is hidden and shown again. The section is hidden while the Session has no shared tasks and no task-record error, independently of the Subagents section. Turning it off retains tasks and subagents. The entire switch row highlights on hover and toggles the selection when clicked. The switch calls `remote.agentTeams.setEnabled`, waits for the saved projection and reports failures through the menu host; the row cannot toggle while locked or saving.

Turning off the menu switch requires confirmation after the Session records a model request; a model choice alone does not require it. The switch waits while request history is unavailable. The dialog explains the tool, coordination, and possible cache effects without deleting task records. Cancel, Escape, or closing the dialog leaves Team mode unchanged. Dismissing the dialog returns focus to the model selector. Confirmation targets the originating Session, waits for the save, and keeps failures visible for retry; it does not depend on the model menu remaining open. Team mode has no slash command; menu changes create no `command/run` or `command/done` records.

Chat hides historical `/team on` and `/team off` receipts with pending or successful outcomes. Failures remain visible with a Users icon, a localized “Agent teamwork” title, and a localized failure prefix followed by the first nonempty line of the recorded reason without translation. Expanding the receipt shows the full original error. Unknown or missing arguments retain a visible receipt.

The [Web bundle](../../bundle/web-app/README.md) loads this package by default. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The panel draws the section title, and the title control (`conversation.session.panel.section.actions`, key `shared-tasks`) shows completed, in-progress, and pending counts, with zero counts omitted and wording and separators matching the input task list. Compact read-only rows show the subject, status, and a chevron on one 28px line, with 13px primary titles; expanded details use 12px text and start at the title's edge. Resting the pointer on a collapsed row for 500ms opens a hover card with the full subject, the owner, the description, and the status. Task rows follow the panel's columns, like subagent rows: the status glyph's center 14px from the row start, titles at 30px, and the chevron's center 14px from the row end. All task details start closed; opening one closes the previous task. Details show only the full description when present, followed by a single-line owner label and owner name in the same color with a 4px gap. Long owner names are ellipsized and reveal their full text in a tooltip only when clipped. Owner tooltips appear after 500ms of hover. Owners display the task's saved `ownerName`, such as `lead` or `reviewer/checker`, independently of loaded subagent catalogs. A task without `ownerName` displays its `ownerId`; a task without either field displays the localized unowned label. The Session panel scrolls the board; task lists and details have no nested scrolling. Agents mutate tasks through tools; the panel provides no mutation controls. A projection failure appears separately above any retained tasks and remains visible when no tasks exist.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries, its Session panel section with the title control, and its model-menu slots through Cordis effects; it mounts no Remote namespace. The [model menu](../ui-model-selection/README.md#use-this-package) owns pane navigation and focus return; Team contributes the root summary through `conversation.input.model.options` and settings through `conversation.input.model.pane` with key `agent-team`. Disposing the plugin fiber removes its registrations.

The Session panel owns showing, scrolling, and dismissing the section, which registers as `shared-tasks` at `order: 250`. The board reads the current Session’s mode and tasks through `useProjection('agentTeam')`. An available, enabled projection supplies the task section only when it contains nondeleted tasks; a projection failure can render independently without a task section. Task IDs, dependencies, readiness, write scopes, and write scope warnings remain in task data but are not displayed as detail fields; blocked pending tasks still use the warning glyph.

The [Chat visibility policy](../ui-chat/src/client/contract/chat-visibility.ts) hides only historical commands named `team` whose trimmed recorded arguments are exactly `on` or `off` and whose outcome is pending or successful. The remaining receipts use a localized running summary or preserve raw successful output, with a localized completed fallback when that text is empty. Rendering neither reads the current Team projection nor parses English outcome text. Filtering and localization affect only Chat presentation: command records, logs, trajectory, and raw errors remain unchanged.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, Session panel section, and model-menu registrations |
| [`src/client/TeamBoard.tsx`](src/client/TeamBoard.tsx) | Projection-derived task section |
| [`src/client/locales.ts`](src/client/locales.ts) | Panel and command copy in eight languages |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web bundle](../../bundle/web-app/README.md) — mounts the Client plugin by default.
- [Agent Teams service](../../team/agent-team/README.md) — authoritative task and projection behavior.
- [Session panel](../ui-session-panel/README.md) — hosts the Shared tasks section and draws its title.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No mailbox timeline** — the panel displays tasks, not messages.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
