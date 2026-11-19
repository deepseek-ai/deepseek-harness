# Agent Note: Session panel in the Chat View's end gutter

Status: implemented

English | [中文](2026-11-05-session-panel.zh.md)

## Problem

Facts about the current Session — its project directory, the change requests it opened, and later its outputs — had no common home. Each owner added its own Session header button and, for anything larger than a menu, a right-sidebar tab: the forge change requests are one such tab. A sidebar tab takes width from the transcript while it shows, shows one tab at a time, and leaves the facts one click away from every message. The required surface is a summary the user can keep beside the conversation without covering it, that several plugins fill independently, that hides when there is no room, and that the user can show or hide from the Session header.

## Decision

[`dsh-client-ui-session-panel`](../../../../packages/client/ui-session-panel/README.md) adds a Session header toggle (`conversation.session.header.utilities`, order −10) and a floating panel that occupies `conversation.chat.aside`, a slot that [`ui-chat`](../../../../packages/client/ui-chat/README.md#scroll-ownership) renders in the Chat View beside the turn rail. The aside is a zero-height layer at the top of the Chat frame and, like the turn rail, is sticky inside the shared scrollport: the panel does not scroll with the transcript, inherits the scrollport's composer and viewport heights, and needs no seat in the Conversation shell. Views other than Chat show no panel.

### Docking follows the transcript gutter

The panel docks only while the gutter between the transcript column and the Chat frame's end edge can hold it (348px: 40px clear of the column and its width handle, a 300px minimum width, and an 8px margin). The gutter, not the viewport width, decides because the column width is adaptive and user-draggable and the right sidebar shares the frame: the same viewport can leave 75px or 600px. The Chat View owns the frame and the transcript column, so its aside layer publishes the gutter as the `--dsh-chat-aside-gutter` custom property, and the panel's stylesheet sizes the docked panel from it.

Script still needs the decision, because docked and overlay differ in behavior and not only in size: the toggle reports `aria-expanded` truthfully and knows whether a press flips docking or opens the overlay, the overlay closes on Escape and on outside presses and returns focus, and an open overlay closes once the panel can dock. A CSS-only container query cannot tell an element outside the Chat View, or a listener, any of that. The stylesheet therefore computes the decision as well: each mounted panel renders a zero-height dock probe that is 1px wide from the gutter that holds the panel's minimum width and 0 below it, derived from the same metrics as the docked width, and the plugin observes only that probe. It hears the decision flip; observing the frame and the transcript column would call back on every frame of a streamed reply, because the column's height changes with its content, and on every step of a window resize. A Session has room to dock while any of its probes does, and a Session without a probe shows no Chat View. The toggle and the panel decide the presentation with the same pure function. While no Chat View shows the Session, as in the trajectory View, the toggle is unavailable and its tooltip asks for the Chat view; `ui-conversation` keeps View selection inside its shell, so the toggle does not switch Views itself.

Docking follows one persisted preference shared by every Session and defaults to on. Without room, a press opens a transient overlay for that Session above the transcript; it never changes the preference, and it closes once its gutter can dock the panel or no Chat View shows the Session any longer, so it never reappears on its own. The panel state follows the reported gutter of the open overlay's Session. A panel withdraws its report when it unmounts or its Chat View moves to another Session, in a layout-effect cleanup kept apart from the gutter update, so a changed gutter never reads as an unmount. Hiding automatically and overlaying on request keeps the transcript uncovered without making the facts unreachable on laptop widths.

### Sections are registrations; the panel draws titles

Each section is one list registration with `id`, `order`, and a required `label`. The panel projects the live registrations into titles, draws each title, and renders the section body with `renderSlot(..., { only: id })`; a CSS `:has()` rule hides a section whose body rendered nothing, so a section opts out by rendering nothing and no effect reports visibility to the owner. Trailing title controls are a keyed slot addressed by the section `id`, and a section that several plugins share declares its own row slot, as the built-in Environment section does with `conversation.session.panel.environment.row`. Marks that must stay visible while the panel is hidden go in an indicator list over the toggle.

Rows from every contributor share one look through the panel's stylesheet instead of a shared component: each contributor writes its row's markup and marks the parts, and the panel lays them out, so icon, text, and trailing areas align across packages. A shared row component would receive each contributor's icon, text, and controls as React nodes in props, which the client rules forbid, and a feature package cannot share its own row component with another feature package.

A section's list shows five rows of each group and then a fold control, because a Session with many subagents, shared tasks, or background jobs would otherwise push the later sections out of the panel's height. Each list orders its rows so that the ones it holds back are the least current: running rows first and then the most recent ones, or for shared tasks, which carry no times, the unfinished tasks before the completed ones. The fold control is the one row the panel does offer as a Component Factory, `conversation.session.panel.fold`: it is the same in every section and takes only data and a callback, while each section keeps its fold state and decides which rows show.

### The turn rail sits at the start edge

The turn rail sits at the scrollport's start edge with its marks, focus ring, and preview mirrored, leaving the end gutter to the docked panel; its 900px hiding rule guarantees room beside the start-side width handle.

## Alternatives considered

- **A seat in `conversation.content`.** Rejected: it made `ui-conversation` render the panel beside the width handles and outside the scrollport, have its width controls measure the gutter into a per-Session `ctx.uiConversation.layouts` source, and move the composer and viewport height variables from the scrollport to the content body so the seat could read them. The Conversation shell would carry geometry and variable placement for one feature, while chrome that must not scroll can sit sticky inside the scrollport as the turn rail does, and the Chat View already owns the column it would measure.
- **A right-sidebar tab.** It already exists for change requests, but it narrows the transcript while shown, shows one tab at a time, and the [UI guidance](../../../skills/dsh-client-ui-ux/SKILL.md#reuse-before-adding) reserves the sidebar for content opened on demand rather than a resident summary.
- **The dock kit's floating window.** `FloatLayer` windows are draggable, resizable, and positioned in viewport coordinates; a summary anchored to the transcript gutter needs none of that and would have to fight the window's own placement rules.
- **Viewport-width breakpoints.** The transcript width is adaptive and draggable and the right sidebar takes a variable track, so a viewport breakpoint either covers the transcript or hides the panel with room to spare.
- **CSS-only hiding with a click-time read.** A container query on the gutter can hide the docked panel, and the toggle could read the computed result when pressed, as the background-job trigger does. The toggle would still render without knowing whether the panel shows, so `aria-expanded` and its tooltip would be wrong whenever the preference says dock but the gutter is too narrow.
- **Narrowing the transcript to make room.** Docking in narrower frames by narrowing the transcript column changes the reading width without the reader asking. The column moves into its start gutter for the panel and keeps its width ([decision](2026-11-16-session-panel-makes-room.md)).
- **A Session-scoped standard hook for the gutter.** Adding a hook to every Session-scoped Slot would make every component fixture in the client restate it; the docking decision has two readers, the panel and the toggle, and both read it from the plugin's own state.

## Consequences

- With the default transcript width, which stops at 880px, the body must be 1576px wide to dock in the gutter alone; narrower bodies dock by [moving the transcript aside](2026-11-16-session-panel-makes-room.md), and those too narrow for that use the overlay; the panel never covers the transcript unless the user opens it.
- Sections from independent plugins share one surface, ordering, and title style without depending on each other, and an occupied section id can be replaced by a higher-priority registration.
- `ui-chat` gained one slot and one custom property on its layer and observes nothing for them. Each mounted panel adds one `ResizeObserver` on its dock probe, which calls back only when the docking decision flips. `ui-conversation` caps the default transcript width at 880px.
- The panel shows only in Chat Views; elsewhere the toggle stays in the header, unavailable. Every Chat View occurrence renders the aside, so a Session shown in the main body and in an embedded Conversation at once shows its overlay in both.
- The turn rail's position changed for every user; its behavior and hiding rule did not.
- Change requests, background jobs, and subagents became sections, replacing the change requests sidebar tab, its start-page entry, and the header controls of jobs and subagents; the header keeps the subagent breadcrumb switcher for child Sessions. A section mounts only while the panel shows, so state that must outlast hiding the panel, such as cleared job rows, lives in a per-Session slot store.
