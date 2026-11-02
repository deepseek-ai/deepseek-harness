---
description: "Inspect the shared task board from the Web conversation header."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package displays shared tasks below the Subagent tree in one header panel. Host projection frames keep task state current without a refresh control. Ordinary subagent navigation owns the member list and teammate conversations. The Web bundle loads this package; it adds no model-facing input.

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

In the root conversation’s model and reasoning menu, turn on **Enable agent teamwork**. New Sessions default to off. While enabled, open the root conversation’s Subagent control to see members above shared tasks. Child conversations keep subagent navigation without a task board or Team switch, including before their subagent address is discovered. The entry is hidden when both the subagent catalog and shared tasks are empty; catalog and task-record errors remain accessible. Section headers appear only when Team mode is enabled, at least one nondeleted shared task exists, and the task footer is available. In that case, the noncollapsible Subagents section remains above shared tasks even when its catalog is empty. Otherwise, the menu shows only subagent navigation, without section headers, a shared-task module, empty-state copy, or a divider. Turning it off retains tasks and subagents. The entire Team row highlights on hover and toggles the selection when clicked, except for its independent information button. The switch calls `remote.agentTeams.setEnabled`, waits for the saved projection and reports failures through the menu host; the row cannot toggle while locked or saving. The adjacent information button explains shared-task coordination and additional token use on hover, keyboard focus, or click/tap without changing the selection. Escape or an outside press dismisses the explanation.

Turning off the menu switch requires confirmation after the Session records a model request; a model choice alone does not require it. The switch waits while request history is unavailable. The dialog explains the tool, coordination, and possible cache effects without deleting task records. Cancel, Escape, or closing the dialog leaves Team mode unchanged. Dismissing the dialog returns focus to the model selector. Confirmation targets the originating Session, waits for the save, and keeps failures visible for retry; it does not depend on the model menu remaining open. Team mode has no slash command; menu changes create no `command/run` or `command/done` records.

Chat hides historical `/team on` and `/team off` receipts with pending or successful outcomes. Failures remain visible with a Users icon, a localized “Agent teamwork” title, and a localized failure prefix followed by the first nonempty line of the recorded reason without translation. Expanding the receipt shows the full original error. Unknown or missing arguments retain a visible receipt.

The [Web bundle](../../bundle/web-app/README.md) loads this package by default. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The noncollapsible Shared tasks header uses a Checklist icon and completed, in-progress, and pending counts, with zero counts omitted and wording and separators matching the input task list. Compact read-only rows show the subject, status, and a chevron, with 13px primary titles and hover geometry aligned to subagent rows; expanded details use 12px text. Task rows use 7px vertical padding, 6px horizontal padding, and 7px gaps to align their clickable content with subagent rows. All task details start closed; opening one closes the previous task. Details show only the full description when present, followed by a single-line owner label and owner name in the same color with a 4px gap. Long owner names are ellipsized and reveal their full text in a tooltip only when clipped. Task-text and owner tooltips appear after 500ms of hover. Owners display the task's saved `ownerName`, such as `lead` or `reviewer/checker`, independently of loaded subagent catalogs. A task without `ownerName` displays its `ownerId`; a task without either field displays the localized unowned label. The shared menu is 360px wide with 6px outer padding, constrained to fit the viewport. Shared tasks have a 4px top margin rather than a divider. Both section headers keep a 7px icon/title gap and an additional 4px before their counts. Only the menu scrolls; task lists and details have no nested scrolling. Agents mutate tasks through tools; the panel provides no mutation controls. A projection failure appears separately above any retained tasks and remains visible when no tasks exist.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries and subagent-catalog and model-menu slots through Cordis effects; it mounts no Remote namespace. Disposing the plugin fiber removes its registrations.

The Subagent catalog owns the shared panel, scrolling, hover, keyboard, and dismissal interactions. This package contributes the task section only below the root conversation’s tree. The board reads the current Session’s mode and tasks through `useProjection('agentTeam')`. An available, enabled projection supplies the task section only when it contains nondeleted tasks; a projection failure can render independently without a task section. Task IDs, dependencies, readiness, write scopes, and write scope warnings remain in task data but are not displayed as detail fields; blocked pending tasks still use the warning glyph.

The [Chat visibility policy](../ui-chat/src/client/contract/chat-visibility.ts) hides only historical commands named `team` whose trimmed recorded arguments are exactly `on` or `off` and whose outcome is pending or successful. The remaining receipts use a localized running summary or preserve raw successful output, with a localized completed fallback when that text is empty. Rendering neither reads the current Team projection nor parses English outcome text. Filtering and localization affect only Chat presentation: command records, logs, trajectory, and raw errors remain unchanged.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, catalog-section, and model-menu registrations |
| [`src/client/TeamBoard.tsx`](src/client/TeamBoard.tsx) | Projection-derived task section |
| [`src/client/locales.ts`](src/client/locales.ts) | Panel and command copy in eight languages |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web bundle](../../bundle/web-app/README.md) — mounts the Client plugin by default.
- [Agent Teams service](../../team/agent-team/README.md) — authoritative task and projection behavior.
- [Conversation UI](../ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.

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
