---
description: "The Session panel: a header toggle and a floating panel over the main Conversation body whose sections other plugins register, with the built-in Environment section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-panel

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-session-panel` adds a Session header toggle that shows or hides a floating panel of facts about the current Session. The panel docks in the main Conversation body's end gutter when the gutter can hold it, and otherwise opens over the transcript on request. It draws section titles and leaves section content to the plugins that register sections; it ships the Environment section with the working folder row.

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

The `@deepseek-ai/dsh-web-app` bundle loads this package by default. The toggle is the first Session header utility, before sharing and the schedule catalog. It is an icon button with the panel name and its indicators as its accessible name, a tooltip that says whether a press shows or hides the panel, and `aria-expanded` for whether the panel shows.

### Docking and the overlay

The panel docks while the gutter between the transcript column and the body's end edge is at least 344px: 48px clear of the column and its width handle, the panel's 280px minimum width, and a 16px edge margin. Docked, it is 280–340px wide, starts 12px below the header, and scrolls inside itself. Pressing the toggle then flips one docking preference that every Session shares and that persists in `localStorage` under `dsh.sessionPanel.pinned`; the panel docks by default.

A narrower gutter hides the docked panel, so it never covers the transcript. This includes a narrow window, an expanded right sidebar, a dragged-wide transcript column, and every View other than Chat, because those Views fill the body. Pressing the toggle then opens the panel over the transcript with the prominent elevation, above the composer stack and not covering it. The overlay closes from the toggle, on Escape, and on a pointer press outside the panel, the toggle, and any open menu, such as a row's context menu; Escape returns focus to the toggle when focus was inside the panel. A modal above the page, an input method composing text, and a handler that already took the key, such as an open menu's, keep Escape; otherwise the overlay takes it first, so with the overlay open the first Escape from the composer closes the overlay and does not count toward stopping a running turn. Closing it does not change the docking preference. At most one Session's overlay is open; it closes once the gutter widens enough to dock and once the main body shows another Session, and switching back does not reopen it. When the panel hides while focus is inside it, focus moves to the toggle.

<a id="contribute-a-section"></a>
### Contribute a section

A section is one `conversation.session.panel.section` list registration: `id` addresses it, `order` sorts it ascending, and the required `label` is its title, which the panel draws in the active locale. The section component receives `presentation` (`docked` or `overlay`) and `dismissOverlay()` as owner props; it renders its body and renders nothing when it has nothing to show, which hides its title too. Register trailing title controls, such as a count or a refresh button, in the keyed `conversation.session.panel.section.actions` slot under the section's `id`. A section without a label is reported to the console and not shown. The shipped sections are Environment (`order: 0`), Change requests from the [forge bundle](../../experimental/client-ui-forge/README.md) (`100`), [Subagents](../ui-subagent/README.md) (`200`), and [Background jobs](../ui-jobs/README.md) (`300`).

Plugins share a title by registering rows in a section owner's row slot. The built-in Environment section (`id: 'environment'`, `order: 0`) declares `conversation.session.panel.environment.row`, whose rows receive the same owner props as a section; its `project` row (`order: 0`) shows the Session's working folder: the current directory from the `workingDirectory` projection, or, before the projection arrives or when it records none, the directory the Session was created in, then the directory of the Workspace that lists the Session. The row shows the folder name followed by its parent folder in tertiary ink, which clips with an ellipsis; its tooltip names the working folder and gives the full path. Both abbreviate the Host home to `~`. Right-clicking the row or pressing its More button opens the shared `directory` context menu. The forge bundle adds its checkout and local changes rows at orders 20 and 30. A plugin that owns a shared section declares its own row slot the same way.

Marks that must stay visible while the panel is hidden, such as an attention dot, go in the `conversation.session.panel.indicator` list. Each occupant includes text that names it, which becomes part of the toggle's accessible name.

Summary rows from every package use the `PanelRow` primitive, so icon, text, and trailing areas line up across sections; put a row's More button in its `menu` so every row highlights as a whole and reveals its actions the same way.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The toggle and the panel are separate Slot entries that share one plugin-owned visibility source: the persisted docking preference and the Session whose overlay is open. Both read the Session's main body geometry from `ctx.uiConversation.layouts`, which the Conversation width controls write from their existing measurement, and decide the presentation with the same pure function, so the toggle's state never disagrees with the panel. The panel renders inside the main Conversation body, which owns its positioning context, the transcript axis, and the composer stack height.

The panel projects the section list's live registrations (`entriesOfSlot`, so a higher-priority registration with the same `id` replaces a shipped section) into `{ id, label }` rows, recomputed only when the ledger version or the locale revision changes. It renders each section through `renderSlot(..., { only: id })` inside its own title and body; a CSS `:has()` rule hides a section whose body outlet stayed empty, including a shared section whose row outlet stayed empty.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Dictionaries, the toggle, the panel, the Environment section, and the project row |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot declarations and component props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | Docking threshold, presentation, and the shared visibility state |
| [`src/client/sections.ts`](src/client/sections.ts) | Section roster projection |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | The panel, its section titles, and Escape handling |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | The header toggle and its indicators |
| [`src/client/ProjectRow.tsx`](src/client/ProjectRow.tsx) | The working folder row |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web Client Slots](../../../docs/subsystems/slots.md) — list, keyed, and owner-prop semantics the sections rely on.
- [`dsh-client-ui-conversation`](../ui-conversation/README.md) — the Session header utilities, the panel seat, and the main body geometry.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md#component-catalog) — `PanelRow` and `PathLabel`.

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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
