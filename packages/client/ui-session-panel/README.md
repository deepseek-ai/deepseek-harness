---
description: "The Session panel: a header toggle and a floating panel in the Chat View's aside whose sections other plugins register, with a pin that keeps it beside the transcript and the built-in Environment section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-panel

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-session-panel` adds a Session header toggle that shows or hides a floating panel of facts about the current Session. The panel lives in the Chat View: it docks in the Chat View's end gutter when the gutter can hold it, and otherwise opens over the transcript on request. A pin on the panel has the transcript make room, so the panel docks at narrower widths too, and the reader can drag its sections into another order. It draws section titles and leaves section content to the plugins that register sections; it ships the Environment section with the working folder row.

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

The panel docks while the gutter between the transcript column and the Chat frame's end edge is at least 348px: 40px clear of the column and its width handle, the panel's 300px minimum width, and an 8px edge margin. Docked, it is 300–360px wide, 8px from the end edge, starts 12px below the header, stops above the composer stack, and scrolls inside itself in a reserved scrollbar column 2px from its end edge, so its content keeps one width whether or not it scrolls. Pressing the toggle then flips one docking preference that every Session shares and that persists in `localStorage` under `dsh.sessionPanel.pinned`; the panel docks by default. That key holds the docking preference, not [the pin](#the-pin).

A narrower gutter hides the docked panel unless [the pin](#the-pin) is on, so it never covers the transcript. This includes a narrow window, an expanded right sidebar, and a dragged-wide transcript column. Pressing the toggle then opens the panel over the transcript with the prominent elevation, 280px wide so it covers less of the transcript than the docked panel takes beside it, 8px from the end edge, above the composer stack and not covering it. The overlay closes from the toggle, on Escape, and on a pointer press outside the panel, the toggle, and any open menu, such as a row's context menu; Escape returns focus to the toggle when focus was inside the panel. A modal above the page, an input method composing text, and a handler that already took the key, such as an open menu's, keep Escape; otherwise the overlay takes it first, so with the overlay open the first Escape from the composer closes the overlay and does not count toward stopping a running turn. Closing it does not change the docking preference. At most one Session's overlay is open; it closes once the gutter widens enough to dock and once no Chat View shows the Session, as after switching to another Session or View, and switching back does not reopen it. When the panel hides while focus is inside it, focus moves to the toggle.

Other Views, such as the trajectory View, show no panel. While no Chat View shows the Session, the toggle is unavailable: it stays in the header with its indicators, dimmed, and its tooltip asks to switch to the Chat view.

<a id="the-pin"></a>
### The pin

The pin is a 24px button in the panel's top end corner, on the first shown section's title line, with its glyph in the column of the rows' More buttons. It is a toggle button named “Pin session panel” with `aria-pressed`, an outlined glyph in tertiary ink while off and a filled glyph in primary ink while on; its tooltip, shown after 500ms of hover or at once on keyboard focus, says what a press does. Every Session shares one pin, which persists in `localStorage` under `dsh.sessionPanel.held` and is off by default. The button shows where a press has an effect: on a docked panel, on an overlay whose transcript can make room, and wherever the pin is on.

While the pin and the docking preference are both on and the gutter is narrower than 348px, the Conversation body keeps that gutter free for the panel. The transcript column and the composer move toward the start edge by the missing gutter and keep their width; once the column is 32px from the start edge, it narrows instead. The panel docks in that gutter, 300px wide, and neither Escape nor an outside press hides it. The body makes no room when that would leave the column under 480px, which is a Chat frame under 860px wide. The pinned panel then behaves as an unpinned one: it hides, the toggle opens it as the overlay, and it docks again once the frame is wide enough. An embedded Chat View, such as a side conversation, never makes room. A gutter that holds the panel by itself needs no room made, and the transcript stays centered.

Pinning also sets the docking preference, so pinning a panel that the toggle had hidden in a wide window shows it. The toggle still hides and shows a pinned panel; hiding it gives the room back to the transcript. Unpinning a panel that only the pin kept beside the transcript leaves it open as the overlay, so it does not vanish under the pointer, and the next outside press closes it.

<a id="section-order"></a>
### Section order

Sections show in ascending `order` until the reader arranges them. Each section's title row is a drag source: over it the pointer is a grab cursor and a drag handle shows over the row's end, in the column of the rows' More buttons. The handle takes no room in the row: the title's trailing content, such as a count, runs to the row's end. The row's end shows one of the two: the trailing content at rest, and the handle in its place while the pointer is over the title row, while the handle has keyboard focus, and during a drag. Dragging the row dims its section, and the section under the pointer shows a 2px line on its top or bottom edge, whichever half the pointer is over; a drop moves the dragged section there.

The handle is a button named “Reorder” with the section's title, and its tooltip says how to reorder. With focus on it, the up and down arrow keys move the section past the nearest section that shows, and focus stays on the handle. The order is one preference for every Session, persisted in `localStorage` under `dsh.sessionPanel.sectionOrder` as the ids of every live section, including the ones with nothing to show. A section registered after the reader arranged the others follows the section it follows in the registered order.

<a id="contribute-a-section"></a>
### Contribute a section

A section is one `conversation.session.panel.section` list registration: `id` addresses it, `order` sorts it ascending until the reader [arranges the sections](#section-order), and the required `label` is its title, which the panel draws in the active locale. The section component receives `presentation` (`docked` or `overlay`) and `dismissOverlay()` as owner props; it renders its body and renders nothing when it has nothing to show, which hides its title too. Register trailing title content, such as a count, in the keyed `conversation.session.panel.section.actions` slot under the section's `id`; the [drag handle](#section-order) shows in its place while the title row is hovered, so it holds what the reader reads, not a control they press. A section without a label is reported to the console and not shown. The shipped sections are Environment (`order: 0`), Change requests from the [forge bundle](../../experimental/client-ui-forge/README.md) (`100`), [Subagents](../ui-subagent/README.md) (`200`), [Shared tasks](../ui-agent-team/README.md) (`250`), and [Background jobs](../ui-jobs/README.md) (`300`).

Plugins share a title by registering rows in a section owner's row slot. The built-in Environment section (`id: 'environment'`, `order: 0`) declares `conversation.session.panel.environment.row`, whose rows receive the same owner props as a section; its `project` row (`order: 0`) shows the Session's working folder: the current directory from the `workingDirectory` projection, or, before the projection arrives or when it records none, the directory the Session was created in, then the directory of the Workspace that lists the Session. The row shows the folder name followed by its parent folder in tertiary ink, which clips with an ellipsis; its tooltip, shown after 500ms of hover, names the working folder and gives the full path. Both abbreviate the Host home to `~`. Right-clicking the row or pressing its More button opens the shared `directory` context menu. The forge bundle adds its checkout and local changes rows at orders 20 and 30. A plugin that owns a shared section declares its own row slot the same way.

Marks that must stay visible while the panel is hidden, such as an attention dot, go in the `conversation.session.panel.indicator` list. Each occupant is one element: the toggle sizes it to a 6px dot at the glyph's corner, and the occupant sets its `background` and includes text that names it, which becomes part of the toggle's accessible name. Occupants overlap, and a higher `order` paints above a lower one. The `panelShown` owner prop lets a mark that only repeats the panel's content render nothing while the panel shows. Subagents and Background jobs show a blue dot while work runs and the panel does not show (orders 10 and 20); the forge bundle's red attention dot (order 100) paints above them and stays while the panel shows.

Rows share one look without sharing a component. A section's component, or an Environment row entry, writes its row's markup and marks the parts, and the panel's stylesheet lays them out, so icon, text, and trailing areas line up across packages while each package owns what its row contains.

| Mark | Part |
|---|---|
| `data-session-panel-row` | The row: one 28px line. A row with an action or a menu highlights as a whole on hover and while one of its menus is open. |
| `data-row-part="body"` | The icon and the text. A `<button>` body is the row's action, and its press area covers the whole row; the trailing part and the menu stay separate controls above it. Give the button an `aria-label` that starts with its visible text when that text does not describe the action. |
| `data-row-part="icon"` | A 16px decorative glyph inside the body, in the row ink; mark it `aria-hidden`. |
| `data-row-part="content"` | One line of text inside the body, clipped with an ellipsis. |
| `data-row-part="lines"` | Inside the body of a two-line row, the wrapper of the content and the detail. |
| `data-row-part="detail"` | A second line under the content, in smaller tertiary type clipped with an ellipsis, such as the consequence of a status or a command to run. The row grows to two lines: the icon stays beside the first, and the trailing part and the menu center on the row. |
| `data-row-part="trailing"` | A value or control after the body. |
| `data-row-part="menu"` | Row actions, such as a More button, in a 16px column whose center sits 14px from the row's end. A plain `button` there gets a 24px target and a tertiary glyph that darkens on hover without a fill, so it needs no tooltip of its own. They show on row hover, on focus inside the row, and while one has its menu open, and always without hover. |

Leave out a part the row does not have: a `<button>` body or a menu part is what makes the row highlight. A menu part that renders nothing, such as a shared menu button whose target has no menu entries, counts as absent: it takes no room and the row does not highlight for it. Each rule for a part has the specificity of one class, so a row's own class adjusts it.

A section whose list can grow long folds it. It shows the first five rows of the list, or of each group the list has, and then a fold control as the last row, which shows the rest or folds them again. A list folds only when that holds back two rows or more, since the control takes a row itself, and it orders its rows so that the ones it holds back are the least current. The plugin offers the control as the `conversation.session.panel.fold` Component Factory: `renderFactorySlot('conversation.session.panel.fold', { expanded, label, name, onToggle })` renders a row marked `data-session-panel-row="fold"` whose body is the button, in the 12px tertiary type of the section counts, with a 14px chevron in the icon column that points down while rows are held back and up once they all show. `label` is the visible text for the current state, such as “Show 14 more” or “Show less”, and `name` is the accessible name, which starts with `label` and names what the list holds. The section keeps the fold state and decides which rows show; a store declared on its registration keeps the choice while the panel is hidden.

A row whose single line clips its name or leaves out its owner, state, or measures shows them in a hover card. The plugin offers the card's content as the `conversation.session.panel.details` Component Factory: wrap the row in a `HoverCard` and pass `renderFactorySlot('conversation.session.panel.details', { title, lines, status, facts })` as its `content`. Every prop is optional data. `title` is the row's full name, which wraps; leave it out when the name can run long, such as a command, and the row's own view shows it in full. `lines` are secondary lines such as the owner, each stopping after six lines. `status` is a `StateDot` state with its label. `facts` are measures on one line, at most one of each `kind`: `tokens` after a database icon and `duration` after a clock, each with its `label`. The details use the card's dark surface in both themes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The panel is the `conversation.chat.aside` occupant of [`dsh-client-ui-chat`](../ui-chat/README.md#scroll-ownership), so it renders only in Chat Views. The toggle and the panel are separate Slot entries that share one plugin-owned state: the persisted docking preference and pin, the Session whose overlay is open, and the room each mounted panel and each Session has to dock. The stylesheets decide that room. The aside layer publishes its end gutter as `--dsh-chat-aside-gutter`, and the Conversation body publishes the largest end reserve it can keep free as `--dsh-chat-end-reserve-max`; the docked width and two zero-height probes derive from them and from one set of metrics (40px clear, 8px edge, 300px minimum width). The gutter probe is 1px wide exactly from the 348px gutter that holds the panel at its minimum width as the transcript stands, and the reserve probe exactly from a largest reserve of 348px, where the transcript can make that room; each is 0 below it. The panel always renders both probes and attaches them through the injected `createProbeRef`, and the plugin observes only those elements with a `ResizeObserver`: it hears a decision flip and nothing while the window resizes on one side of it, the transcript width is dragged, or the transcript grows. A probe has room from 1px of width, a Session has a kind of room while any of its panels does, and a Session without a probe shows no Chat View. A panel can dock when its gutter holds it, or when the pin is on and the transcript can make room. The panel reads its own probes and the toggle its Session, and both decide the presentation with the same pure function, so the toggle's state never disagrees with the panel; opening, closing, or docking the panel renders nothing in the Chat View. Without `ResizeObserver` no probe gains room, and the panel shows only as an overlay. The aside layer also inherits the scrollport's composer and viewport heights.

While the pin and the docking preference are both on, the gutter probe carries `data-session-panel-reserve`, and a `:has()` rule in the panel's stylesheet sets `--dsh-chat-end-reserve` to 348px on the Conversation body, which then pads its scrollport's end ([end reserve](../ui-conversation/README.md#end-reserve)). The gutter the aside layer publishes counts that inset, and the gutter probe subtracts it, so neither probe depends on the pin: the plugin knows what pinning and unpinning do before either happens, and the room the transcript makes never changes the decision that asked for it.

The panel projects the section list's live registrations (`entriesOfSlot`, so a higher-priority registration with the same `id` replaces a shipped section) into `{ id, label }` rows and puts them in the reader's stored order, recomputed only when the ledger version, the locale revision, or that order changes. It renders each section through `renderSlot(..., { only: id })` inside its own title and body; a CSS `:has()` rule hides a section whose body outlet stayed empty, including a shared section whose row outlet stayed empty.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Dictionaries, the toggle, the panel, the Environment section, and the project row |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot declarations and component props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | Presentation, the shared visibility state with the pin, the room probes, and each Session's room to dock |
| [`src/client/sections.ts`](src/client/sections.ts) | Section roster projection, the reader's stored order, and the move that changes it |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | The panel, its probes, the pin, its section titles with their drag and keyboard reordering, and Escape handling |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | The header toggle and its indicators |
| [`src/client/SessionPanel.module.css`](src/client/SessionPanel.module.css) | The panel's geometry, the probes, the pin, the request for the transcript's room, and the rules for marked rows |
| [`src/client/ProjectRow.tsx`](src/client/ProjectRow.tsx) | The working folder row |
| [`src/client/PanelFold.tsx`](src/client/PanelFold.tsx) | The fold control of a folded list, offered as a Component Factory |
| [`src/client/PanelDetails.tsx`](src/client/PanelDetails.tsx) | The details in a row's hover card, offered as a Component Factory |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web Client Slots](../../../docs/subsystems/slots.md) — list, keyed, and owner-prop semantics the sections rely on.
- [`dsh-client-ui-chat`](../ui-chat/README.md#scroll-ownership) — the `conversation.chat.aside` layer and its `--dsh-chat-aside-gutter` property.
- [`dsh-client-ui-conversation`](../ui-conversation/README.md#end-reserve) — the Session header utilities and the body's end reserve.
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

- **An unpinned panel overlays at laptop widths** — with the default transcript width the body must be at least about 1580px wide to dock without the pin; narrower bodies use the overlay until the reader pins the panel.
- **No width handles while the transcript makes room** — the handles sit at the centered column's edges and a drag widens the column about its center, so they do not show while a pinned panel holds the column off center. Unpinning or hiding the panel brings them back.
- **Embedded Chat Views make no room** — an embedded transcript follows its frame's width, so a pinned panel docks there only in a gutter that holds it.
- **No execution environment row** — the Client has no per-Session fact for the local machine, an SSH host, or the sandbox mode, so the Environment section names only the working folder.
- **Sections cannot be hidden** — every live section shows; the reader can reorder sections but not hide one.
- **No drag on touch input** — dragging uses the browser's drag and drop, which a touch does not start, and the handle's arrow keys need a keyboard.
- **No switch back to Chat from other Views** — `dsh-client-ui-conversation` exposes no View selection to plugins, so the toggle in the trajectory View cannot select the Chat View for the user.
- **An overlay shows in each Chat View of its Session** — every Chat View occurrence, main or embedded, renders the aside, so a Session shown in the main body and in an embedded Conversation at once shows its overlay in both.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
