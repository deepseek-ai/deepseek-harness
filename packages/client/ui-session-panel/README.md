---
description: "The Session panel: a header toggle and a floating panel in the Chat View's aside whose sections other plugins register, with the built-in Environment section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-panel

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-session-panel` adds a Session header toggle that shows or hides a floating panel of facts about the current Session. The panel lives in the Chat View: it docks in the Chat View's end gutter when the gutter can hold it, and otherwise opens over the transcript on request. It draws section titles and leaves section content to the plugins that register sections; it ships the Environment section with the working folder row.

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

The `@deepseek-ai/dsh-web-app` bundle loads this package by default. The toggle is the first Session header utility, before sharing and the schedule catalog. It is an icon button with the panel name and its indicators as its accessible name, a tooltip that says whether a press shows or hides the panel, shown after 500ms of hover or at once on keyboard focus, and `aria-expanded` for whether the panel shows.

### Docking and the overlay

The panel docks while the gutter between the transcript column and the Chat frame's end edge is at least 348px: 40px clear of the column and its width handle, the panel's 300px minimum width, and an 8px edge margin. Docked, it is 300–360px wide, 8px from the end edge, starts 12px below the header, stops above the composer stack, and scrolls inside itself in a reserved scrollbar column 2px from its end edge, so its content keeps one width whether or not it scrolls. Pressing the toggle then flips one docking preference that every Session shares and that persists in `localStorage` under `dsh.sessionPanel.pinned`; the panel docks by default.

A narrower gutter hides the docked panel, so it never covers the transcript. This includes a narrow window, an expanded right sidebar, and a dragged-wide transcript column. Pressing the toggle then opens the panel over the transcript with the prominent elevation, 280px wide so it covers less of the transcript than the docked panel takes beside it, 8px from the end edge, above the composer stack and not covering it. The overlay closes from the toggle, on Escape, and on a pointer press outside the panel, the toggle, and any open menu, such as a row's context menu; Escape returns focus to the toggle when focus was inside the panel. A modal above the page, an input method composing text, and a handler that already took the key, such as an open menu's, keep Escape; otherwise the overlay takes it first, so with the overlay open the first Escape from the composer closes the overlay and does not count toward stopping a running turn. Closing it does not change the docking preference. At most one Session's overlay is open; it closes once the gutter widens enough to dock and once no Chat View shows the Session, as after switching to another Session or View, and switching back does not reopen it. When the panel hides while focus is inside it, focus moves to the toggle.

Other Views, such as the trajectory View, show no panel. While no Chat View shows the Session, the toggle is unavailable: it stays in the header with its indicators, dimmed, and its tooltip asks to switch to the Chat view.

<a id="contribute-a-section"></a>
### Contribute a section

A section is one `conversation.session.panel.section` list registration: `id` addresses it, `order` sorts it ascending, and the required `label` is its title, which the panel draws in the active locale. The section component receives `presentation` (`docked` or `overlay`) and `dismissOverlay()` as owner props; it renders its body and renders nothing when it has nothing to show, which hides its title too. Register trailing title controls, such as a count or a refresh button, in the keyed `conversation.session.panel.section.actions` slot under the section's `id`. A section without a label is reported to the console and not shown. The shipped sections are Environment (`order: 0`), Change requests from the [forge bundle](../../experimental/client-ui-forge/README.md) (`100`), [Subagents](../ui-subagent/README.md) (`200`), [Shared tasks](../ui-agent-team/README.md) (`250`), and [Background jobs](../ui-jobs/README.md) (`300`).

Plugins share a title by registering rows in a section owner's row slot. The built-in Environment section (`id: 'environment'`, `order: 0`) declares `conversation.session.panel.environment.row`, whose rows receive the same owner props as a section; its `project` row (`order: 0`) shows the Session's working folder: the current directory from the `workingDirectory` projection, or, before the projection arrives or when it records none, the directory the Session was created in, then the directory of the Workspace that lists the Session. The row shows the folder name followed by its parent folder in tertiary ink, which clips with an ellipsis; its tooltip, shown after 500ms of hover, names the working folder and gives the full path. Both abbreviate the Host home to `~`. Right-clicking the row or pressing its More button opens the shared `directory` context menu. The forge bundle adds its checkout and local changes rows at orders 20 and 30. A plugin that owns a shared section declares its own row slot the same way.

Marks that must stay visible while the panel is hidden, such as an attention dot, go in the `conversation.session.panel.indicator` list. Each occupant is one element: the toggle sizes it to a 6px dot at the glyph's corner, and the occupant sets its `background` and includes text that names it, which becomes part of the toggle's accessible name. Occupants overlap, and a higher `order` paints above a lower one. The `panelShown` owner prop lets a mark that only repeats the panel's content render nothing while the panel shows. Subagents and Background jobs show a blue dot while work runs and the panel does not show (orders 10 and 20); the forge bundle's red attention dot (order 100) paints above them and stays while the panel shows.

The plugin offers its row as the `conversation.session.panel.row` Component Factory. Sections and Environment rows from every package render their rows with `renderFactorySlot('conversation.session.panel.row', props)`, so icon, text, and trailing areas line up across sections. A row has a 16px decorative icon that inherits the row ink, single-line content that clips with an ellipsis, and an optional trailing value or control. `menu` holds row actions, such as a More button, after the trailing area in a 16px column whose center sits 14px from the row's end; a plain `button` there gets a 24px target and a tertiary glyph that darkens on hover without a fill, so it needs no tooltip of its own. They show on row hover, on focus inside the row, and while one has its menu open, and always without hover. `onActivate` makes the whole row one button while the trailing area and the menu stay separate controls, and `actionLabel` names that button when its content does not describe the action, starting with the visible text; a row with an action or row actions fills as a whole on hover and while one of its menus is open. `detail` adds a second line in smaller tertiary type that clips with an ellipsis, such as the consequence of a status or a command to run; the icon stays beside the first line and the trailing area and menu center on the row. `className` adds to the row's class, and `attributes`, such as `role`, `data-*` markers, and context-menu trigger props, reach the row element; other props are ignored.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The panel is the `conversation.chat.aside` occupant of [`dsh-client-ui-chat`](../ui-chat/README.md#scroll-ownership), so it renders only in Chat Views. The toggle and the panel are separate Slot entries that share one plugin-owned state: the persisted docking preference, the Session whose overlay is open, and whether each Session has room to dock. Each mounted panel registers the `endGutter` source of its Chat View with that state, and stops when it unmounts or its Chat View moves to another Session; a Session has room while any of its sources holds the docked panel, and a Session without a source shows no Chat View. The panel decides its presentation from its own source, and both decide with the same pure function, so the toggle's state never disagrees with the panel. The panel and the toggle subscribe only to whether the gutter holds the docked panel, so a resize renders them again only when it crosses the 348px threshold, and opening, closing, or docking the panel renders nothing in the Chat View. The aside layer inherits the scrollport's composer and viewport heights and the transcript width `--dsh-chat-content-width`, from which CSS sizes the docked panel.

The panel projects the section list's live registrations (`entriesOfSlot`, so a higher-priority registration with the same `id` replaces a shipped section) into `{ id, label }` rows, recomputed only when the ledger version or the locale revision changes. It renders each section through `renderSlot(..., { only: id })` inside its own title and body; a CSS `:has()` rule hides a section whose body outlet stayed empty, including a shared section whose row outlet stayed empty.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Dictionaries, the row Factory, the toggle, the panel, the Environment section, and the project row |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot declarations and component props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | Docking threshold, presentation, the shared visibility state, and each Session's room to dock |
| [`src/client/sections.ts`](src/client/sections.ts) | Section roster projection |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | The panel, its section titles, and Escape handling |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | The header toggle and its indicators |
| [`src/client/PanelRow.tsx`](src/client/PanelRow.tsx) | The panel row behind the `conversation.session.panel.row` Factory |
| [`src/client/ProjectRow.tsx`](src/client/ProjectRow.tsx) | The working folder row |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web Client Slots](../../../docs/subsystems/slots.md) — list, keyed, and owner-prop semantics the sections rely on.
- [`dsh-client-ui-chat`](../ui-chat/README.md#scroll-ownership) — the `conversation.chat.aside` layer and its end gutter source.
- [`dsh-client-ui-conversation`](../ui-conversation/README.md) — the Session header utilities.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md#component-catalog) — `Button`, `Tooltip`, the icons, and the modal and composition guards.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders facts the Client already holds for a human and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **Laptop widths overlay rather than dock** — with the default transcript width the body must be at least about 1608px wide to dock; narrower bodies use the overlay. Docking by moving the transcript column aside is a separate layout decision.
- **No execution environment row** — the Client has no per-Session fact for the local machine, an SSH host, or the sandbox mode, so the Environment section names only the working folder.
- **No section customization** — every live section shows; hiding or reordering sections from the panel is not offered.
- **No switch back to Chat from other Views** — `dsh-client-ui-conversation` exposes no View selection to plugins, so the toggle in the trajectory View cannot select the Chat View for the user.
- **An overlay shows in each Chat View of its Session** — every Chat View occurrence, main or embedded, renders the aside, so a Session shown in the main body and in an embedded Conversation at once shows its overlay in both.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
