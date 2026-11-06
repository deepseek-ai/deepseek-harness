# Agent Note: Session panel in the Chat View's end gutter

Status: implemented

English | [中文](2026-11-05-session-panel.zh.md)

## Problem

Facts about the current Session — its project directory, the change requests it opened, and later its outputs — had no common home. Each owner added its own Session header button and, for anything larger than a menu, a right-sidebar tab: the forge change requests are one such tab. A sidebar tab takes width from the transcript while it shows, shows one tab at a time, and leaves the facts one click away from every message. The required surface is a summary the user can keep beside the conversation without covering it, that several plugins fill independently, that hides when there is no room, and that the user can show or hide from the Session header.

## Decision

[`dsh-client-ui-session-panel`](../../../../packages/client/ui-session-panel/README.md) adds a Session header toggle (`conversation.session.header.utilities`, order −10) and a floating panel that occupies `conversation.chat.aside`, a slot that [`ui-chat`](../../../../packages/client/ui-chat/README.md#scroll-ownership) renders in the Chat View beside the turn rail. The aside is a zero-height layer at the top of the Chat frame and, like the turn rail, is sticky inside the shared scrollport: the panel does not scroll with the transcript, inherits the scrollport's composer and viewport heights, and needs no seat in the Conversation shell. Views other than Chat show no panel.

### Docking follows the transcript gutter

The panel docks only while the gutter between the transcript column and the Chat frame's end edge can hold it (344px: 48px clear of the column and its width handle, a 280px minimum width, and a 16px margin). The gutter, not the viewport width, decides because the column width is adaptive and user-draggable and the right sidebar shares the frame: the same viewport can leave 75px or 600px. The Chat View owns the frame and the transcript column, so it computes the gutter from the widths a `ResizeObserver` reports for both and passes it to the aside occupant as the `endGutter` owner prop.

Each mounted panel reports its gutter into the plugin's state, and the toggle reads the widest gutter reported for its Session; a Session without a report shows no Chat View. The toggle and the panel decide the presentation with the same pure function, so the toggle reports `aria-expanded` truthfully and knows whether a press flips docking or opens the overlay, which a CSS-only container query cannot tell an element outside the Chat View. While no Chat View shows the Session, as in the trajectory View, the toggle is unavailable and its tooltip asks for the Chat view; `ui-conversation` keeps View selection inside its shell, so the toggle does not switch Views itself.

Docking follows one persisted preference shared by every Session and defaults to on. Without room, a press opens a transient overlay for that Session above the transcript; it never changes the preference, and it closes once its gutter can dock the panel or no Chat View shows the Session any longer, so it never reappears on its own. The panel state follows the reported gutter of the open overlay's Session. A panel withdraws its report when it unmounts or its Chat View moves to another Session, in a layout-effect cleanup kept apart from the gutter update, so a changed gutter never reads as an unmount. Hiding automatically and overlaying on request keeps the transcript uncovered without making the facts unreachable on laptop widths.

### Sections are registrations; the panel draws titles

Each section is one list registration with `id`, `order`, and a required `label`. The panel projects the live registrations into titles, draws each title, and renders the section body with `renderSlot(..., { only: id })`; a CSS `:has()` rule hides a section whose body rendered nothing, so a section opts out by rendering nothing and no effect reports visibility to the owner. Trailing title controls are a keyed slot addressed by the section `id`, and a section that several plugins share declares its own row slot, as the built-in Environment section does with `conversation.session.panel.environment.row`. Marks that must stay visible while the panel is hidden go in an indicator list over the toggle.

Rows from every contributor use the `PanelRow` primitive so icon, text, and trailing areas align across packages; a feature package cannot share its own row component with another feature package.

### The turn rail sits at the start edge

The turn rail sits at the scrollport's start edge with its marks, focus ring, and preview mirrored, leaving the end gutter to the docked panel; its 900px hiding rule guarantees room beside the start-side width handle.

## Alternatives considered

- **A seat in `conversation.content`.** Rejected: it made `ui-conversation` render the panel beside the width handles and outside the scrollport, have its width controls measure the gutter into a per-Session `ctx.uiConversation.layouts` source, and move the composer and viewport height variables from the scrollport to the content body so the seat could read them. The Conversation shell would carry geometry and variable placement for one feature, while chrome that must not scroll can sit sticky inside the scrollport as the turn rail does, and the Chat View already owns the column it would measure.
- **A right-sidebar tab.** It already exists for change requests, but it narrows the transcript while shown, shows one tab at a time, and the [UI guidance](../../../skills/dsh-client-ui-ux/SKILL.md#reuse-before-adding) reserves the sidebar for content opened on demand rather than a resident summary.
- **The dock kit's floating window.** `FloatLayer` windows are draggable, resizable, and positioned in viewport coordinates; a summary anchored to the transcript gutter needs none of that and would have to fight the window's own placement rules.
- **Viewport-width breakpoints.** The transcript width is adaptive and draggable and the right sidebar takes a variable track, so a viewport breakpoint either covers the transcript or hides the panel with room to spare.
- **CSS-only hiding with a click-time read.** A container query on the gutter can hide the docked panel, and the toggle could read the computed result when pressed, as the background-job trigger does. The toggle would still render without knowing whether the panel shows, so `aria-expanded` and its tooltip would be wrong whenever the preference says dock but the gutter is too narrow.
- **Squeezing the transcript to make room.** Docking on laptop widths by moving the transcript column aside changes the centered column, the composer, and both width handles; it remains a separate layout decision.
- **A Session-scoped standard hook for the gutter.** Adding a hook to every Session-scoped Slot would make every component fixture in the client restate it; the gutter has two readers, the panel through its owner props and the toggle through the plugin's own state.

## Consequences

- With the default transcript width the body must be about 1608px wide to dock, so laptop widths use the overlay; the panel never covers the transcript unless the user opens it.
- Sections from independent plugins share one surface, ordering, and title style without depending on each other, and an occupied section id can be replaced by a higher-priority registration.
- `ui-chat` gained one slot and one `ResizeObserver` per Chat View; `ui-conversation` is unchanged.
- The panel shows only in Chat Views; elsewhere the toggle stays in the header, unavailable. Every Chat View occurrence renders the aside, so a Session shown in the main body and in an embedded Conversation at once shows its overlay in both.
- The turn rail's position changed for every user; its behavior and hiding rule did not.
