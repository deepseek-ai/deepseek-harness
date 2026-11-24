---
description: "The Session panel: a header toggle and a floating panel in the Chat View's aside whose sections other plugins register and the reader can reorder, with the built-in Environment section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-panel

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-session-panel` adds a Session header toggle that shows or hides a floating panel of facts about the current Session. The panel lives in the Chat View: it docks beside the transcript, in the Chat View's end gutter or in the room the transcript leaves by moving into its start gutter, and where neither holds it opens over the transcript on request. The reader can drag its sections into another order. It draws section titles and leaves section content to the plugins that register sections; it ships the Environment section with the working folder row.

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

<a id="docking"></a>
### Docking and the overlay

The panel docks while the gutter between the transcript column and the Chat frame's end edge is at least 348px: 40px clear of the column and its width handle, the panel's 300px minimum width, and an 8px edge margin. Docked, it is 300–360px wide, 8px from the end edge, starts 12px below the header, stops above the composer stack, and scrolls inside itself in a reserved scrollbar column 2px from its end edge, so its content keeps one width whether or not it scrolls. Pressing the toggle then flips one docking preference that every Session shares and that persists in `localStorage` under `dsh.sessionPanel.pinned`; the panel docks by default.

Where the gutter is narrower than 348px, the Conversation body moves the transcript column and the composer toward the start edge, at their own widths, until the gutter is 348px, and the panel docks in it at its 300px minimum width ([end reserve](../ui-conversation/README.md#end-reserve)). The body moves them only while the docking preference is on, and only as far as leaves 32px before the column: with the default transcript width that takes a Chat frame about 1068px wide, and a transcript dragged wider takes a wider frame. Turning the docking preference off from the toggle centers the transcript again. An embedded Chat View, such as a side conversation, never moves its transcript.

A press that shows or hides the panel, on the toggle or outside an overlay, plays one motion: the panel slides the 8px between it and the end edge, from that edge or to it, and fades, and the transcript and the composer move into or out of the panel's room over the same 160ms and the same curve, `cubic-bezier(0.4, 0, 0.2, 1)`. A hidden panel stays in the page until its exit ends and takes no presses meanwhile. The panel and the transcript change at once, without that motion, when the room to dock changes: on a switch to another Session, on a reload, while the window resizes, and while the transcript width is dragged. Nothing plays for a reader whose system asks for reduced motion.

Where the start gutter cannot give that room, the docked panel hides, so it never covers the transcript. This includes a narrow window, an expanded right sidebar, and a dragged-wide transcript column. Pressing the toggle then opens the panel over the transcript with the prominent elevation, 280px wide so it covers less of the transcript than the docked panel takes beside it, 8px from the end edge, above the composer stack and not covering it. The overlay closes from the toggle, on Escape, and on a pointer press outside the panel, the toggle, and any open menu, such as a row's context menu; Escape returns focus to the toggle when focus was inside the panel. A modal above the page, an input method composing text, and a handler that already took the key, such as an open menu's, keep Escape; otherwise the overlay takes it first, so with the overlay open the first Escape from the composer closes the overlay and does not count toward stopping a running turn. Closing it does not change the docking preference. At most one Session's overlay is open; it closes once the panel has room to dock and once no Chat View shows the Session, as after switching to another Session or View, and switching back does not reopen it. When the panel hides while focus is inside it, focus moves to the toggle.

Other Views, such as the trajectory View, show no panel. While no Chat View shows the Session, the toggle is unavailable: it stays in the header with its indicators, dimmed, and its tooltip asks to switch to the Chat view.

<a id="section-order"></a>
### Section order

Environment always shows first. The other sections show in ascending `order` until the reader arranges them. The title row of each of those sections is a drag source: over it the pointer is a grab cursor and a drag handle shows at the row's end, in the column of the rows' More buttons. The handle is a mark, not a control, and takes no room in the row: the title's trailing content, such as a count, runs to the row's end. The row's end shows one of the two: the trailing content at rest, and the handle in its place while the pointer is over the title row and during a drag. Dragging the row dims its section, and the section under the pointer shows a 2px line on its top or bottom edge, whichever half the pointer is over; a drop moves the dragged section there. Over Environment the line is always on its bottom edge, since a section lands after it. Environment's title row is no drag source and has no handle. While only one other section shows, its title row offers no drag either, with no grab cursor and no handle, since the only place it could land is the place it has.

The order is one preference for every Session, persisted in the browser's `localStorage` under `dsh.sessionPanel.sectionOrder` as a JSON array of the ids of every live section, including the ones with nothing to show. It belongs to the page's origin: another browser, another profile, or a Web server on another host or port starts from the registered order, and nothing sends the order to the Host. A section registered after the reader arranged the others follows the section it follows in the registered order.

<a id="contribute-a-section"></a>
### Contribute a section

A section is one `conversation.session.panel.section` list registration: `id` addresses it, `order` sorts it ascending until the reader [arranges the sections](#section-order), and the required `label` is its title, which the panel draws in the active locale. The section component receives `presentation` (`docked` or `overlay`) and `dismissOverlay()` as owner props; it renders its body and renders nothing when it has nothing to show, which hides its title too. Register trailing title content, such as a count, in the keyed `conversation.session.panel.section.actions` slot under the section's `id`; in every section but Environment the [drag handle](#section-order) shows in its place while the title row is hovered, so it holds what the reader reads, not a control they press. A section without a label is reported to the console and not shown. The shipped sections are Environment (`order: 0`), Change requests from the [forge bundle](../../experimental/client-ui-forge/README.md) (`100`), [Subagents](../ui-subagent/README.md) (`200`), [Shared tasks](../ui-agent-team/README.md) (`250`), and [Background jobs](../ui-jobs/README.md) (`300`).

Plugins share a title by registering rows in a section owner's row slot. The built-in Environment section (`id: 'environment'`, `order: 0`) declares `conversation.session.panel.environment.row`, whose rows receive the same owner props as a section; its `project` row (`order: 0`) shows the Session's working folder: the current directory from the `workingDirectory` projection, or, before the projection arrives or when it records none, the directory the Session was created in, then the directory of the Workspace that lists the Session. The row shows the folder name followed by its parent folder in tertiary ink, which clips with an ellipsis; its tooltip, shown after 500ms of hover, names the working folder and gives the full path. Both abbreviate the Host home to `~`. Right-clicking the row or pressing its More button opens the shared `directory` context menu. The forge bundle adds its checkout and local changes rows at orders 20 and 30. A plugin that owns a shared section declares its own row slot the same way.

Indicators in the `conversation.session.panel.indicator` list share a 6×6 px area at the top-right of the toggle icon. The toggle positions the container; each contribution draws its own mark. To draw a dot, fill the container with `position: absolute; inset: 0` on your own element, then set its background, round its corners, and add a ring if needed. Include status text for the toggle's accessible name; for a dot, hide the text visually. Return `null` when there is nothing to report, or when `panelShown` is true and the mark only repeats what the panel shows.

Marks overlap: the higher `order` paints on top. Subagents (`10`) and Background jobs (`20`) show a blue dot while work runs and the panel is hidden. The forge bundle's attention dot (`100`) uses the warning color and stays visible while a change request needs attention, even with the panel open.

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

The panel is the `conversation.chat.aside` occupant of [`dsh-client-ui-chat`](../ui-chat/README.md#scroll-ownership), so it renders only in Chat Views. The toggle and the panel are separate Slot entries that share one plugin-owned state: the persisted docking preference, the Session whose overlay is open, and whether each mounted panel and each Session has room to dock. The stylesheets decide that room. The aside layer publishes its end gutter as `--dsh-chat-aside-gutter`, and the Conversation body publishes the largest end reserve its start gutter can give as `--dsh-chat-end-reserve-max`, which is readable only on the body, so the panel's stylesheet turns it there into a registered 0px or 1px step, `--dsh-session-panel-reserve-room`, that changes only when the reserve starts or stops covering the gutter; the docked width and a zero-height dock probe derive from them and from one set of metrics (40px clear, 8px edge, 300px minimum width). The message flow does not inherit that step; crossing the docking threshold does not restyle its rows. The probe is 1px wide while the gutter holds the panel at its minimum width, from 348px, or while the largest reserve covers that gutter, and 0 otherwise. The panel always renders the probe and attaches it through the injected `createProbeRef`, and the plugin observes only that element with a `ResizeObserver`: it hears the docking decision flip and nothing while the window resizes on one side of it, the transcript width is dragged, or the transcript grows. A probe has room from 1px of width, a Session has room while any of its probes does, and a Session without a probe shows no Chat View. The panel reads its own probe and the toggle its Session, and both decide the presentation with the same pure function, so the toggle's state never disagrees with the panel; opening, closing, or docking the panel renders nothing in the Chat View. Without `ResizeObserver` no probe gains room, and the panel shows only as an overlay. The aside layer also inherits the scrollport's composer and viewport heights.

While the docking preference is on, the probe carries `data-session-panel-reserve`, and a `:has()` rule in the panel's stylesheet sets `--dsh-chat-end-reserve` to 348px on the Conversation body, which then pads its scrollport's end by the missing gutter ([end reserve](../ui-conversation/README.md#end-reserve)). The probe's second term reads the largest reserve, not the padding, so its answer is the same before and after the transcript moves: the room the transcript makes never changes the decision that asked for it.

The panel compares what it showed at its last render with what it shows now. When that changes while its room to dock stayed the same, a press caused it: the panel marks itself with `data-session-panel-motion` (`enter` or `exit`) and its probe with `data-session-panel-moving` until the panel's animation ends, and a second `:has()` rule sets `--dsh-chat-end-reserve-transition` on the Conversation body for as long. A panel that mounts learns its room in its first frame, which is a change of room, so it shows without the entrance.

The panel projects the section list's live registrations (`entriesOfSlot`, so a higher-priority registration with the same `id` replaces a shipped section) into `{ id, label }` rows and puts them in the reader's stored order, recomputed only when the ledger version, the locale revision, or that order changes. It renders each body below its title with `renderSlot(..., { only: id })`. CSS hides the section when its body renders nothing, even if an empty [list item root](../../../docs/subsystems/slots.md#list-item-roots) remains. Environment also hides when none of its rows renders content.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Dictionaries, the toggle, the panel, the Environment section, and the project row |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot declarations and component props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | Presentation, the shared visibility state, the dock probes, and each Session's room to dock |
| [`src/client/sections.ts`](src/client/sections.ts) | Section roster projection, the reader's stored order with Environment held first, and the move that changes it |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | The panel, its dock probe, its section titles with their drag reordering, and Escape handling |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | The header toggle and its indicators |
| [`src/client/SessionPanel.module.css`](src/client/SessionPanel.module.css) | The panel's geometry, the dock probe, the request for the transcript's room, and the rules for marked rows |
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

- **Narrow frames overlay rather than dock** — the transcript keeps its width for the panel, so a Chat frame under about 1068px at the default transcript width, or a frame whose transcript was dragged wide, shows the panel only as the overlay.
- **Embedded Chat Views make no room** — an embedded transcript follows its frame's width, so the panel docks there only in a gutter that holds it.
- **No execution environment row** — the Client has no per-Session fact for the local machine, an SSH host, or the sandbox mode, so the Environment section names only the working folder.
- **Sections cannot be hidden** — every live section shows; the reader can reorder sections but not hide one.
- **Reordering needs a mouse** — dragging uses the browser's drag and drop, which a touch does not start, and the panel offers no keyboard way to reorder.
- **The section order stays in one browser** — it is stored in `localStorage`, so it does not follow the reader to another browser or device.
- **No switch back to Chat from other Views** — `dsh-client-ui-conversation` exposes no View selection to plugins, so the toggle in the trajectory View cannot select the Chat View for the user.
- **An overlay shows in each Chat View of its Session** — every Chat View occurrence, main or embedded, renders the aside, so a Session shown in the main body and in an embedded Conversation at once shows its overlay in both.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
