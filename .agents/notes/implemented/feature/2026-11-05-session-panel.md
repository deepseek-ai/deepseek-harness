# Agent Note: Session panel over the Conversation body's end gutter

Status: implemented

English | [中文](2026-11-05-session-panel.zh.md)

## Problem

Facts about the current Session — its project directory, the change requests it opened, and later its outputs — had no common home. Each owner added its own Session header button and, for anything larger than a menu, a right-sidebar tab: the forge change requests are one such tab. A sidebar tab takes width from the transcript while it shows, shows one tab at a time, and leaves the facts one click away from every message. The required surface is a summary the user can keep beside the conversation without covering it, that several plugins fill independently, that hides when there is no room, and that the user can show or hide from the Session header.

## Decision

[`dsh-client-ui-session-panel`](../../../../packages/client/ui-session-panel/README.md) adds a Session header toggle (`conversation.session.header.utilities`, order −10) and a floating panel that [`ui-conversation`](../../../../packages/client/ui-conversation/README.md) seats inside the main Conversation body as `conversation.session.panel`. The seat renders only for the main occurrence of an active Session, beside the width handles and outside the scrollport, so the panel neither scrolls with the transcript nor appears in embedded occurrences or on the blank home.

### Docking follows the transcript gutter

The panel docks only while the gutter between the transcript column and the body's end edge can hold it (344px: 48px clear of the column and its width handle, a 280px minimum width, and a 16px margin). The gutter, not the viewport width, decides because the column width is adaptive and user-draggable and the right sidebar shares the frame: the same viewport can leave 75px or 600px. The Conversation width controls already measure the body and resolve the column width, so they report the gutter after each measurement and drag frame into `ctx.uiConversation.layouts`, a per-Session source on the existing Conversation service. View activation reports whether the active View follows the transcript column; every View other than Chat fills the body, so the gutter reads zero there.

The toggle and the panel read that source and one plugin-owned visibility state and decide the presentation with the same pure function. The toggle therefore reports `aria-expanded` truthfully and knows whether a press flips docking or opens the overlay, which a CSS-only container query cannot tell an element outside the body.

Docking follows one persisted preference shared by every Session and defaults to on. Without room, a press opens a transient overlay for that Session above the transcript and the composer stack; it never changes the preference, and it closes once its gutter can dock the panel or the main body shows another Session, so it never reappears on its own. The panel state follows the open overlay's layout source, which the Conversation shell marks as no longer shown when the main body leaves the Session, instead of a component cleanup that React's double mount would also run. Hiding automatically and overlaying on request keeps the transcript uncovered without making the facts unreachable on laptop widths.

### Sections are registrations; the panel draws titles

Each section is one list registration with `id`, `order`, and a required `label`. The panel projects the live registrations into titles, draws each title, and renders the section body with `renderSlot(..., { only: id })`; a CSS `:has()` rule hides a section whose body rendered nothing, so a section opts out by rendering nothing and no effect reports visibility to the owner. Trailing title controls are a keyed slot addressed by the section `id`, and a section that several plugins share declares its own row slot, as the built-in Environment section does with `conversation.session.panel.environment.row`. Marks that must stay visible while the panel is hidden go in an indicator list over the toggle.

Rows from every contributor use the `PanelRow` primitive so icon, text, and trailing areas align across packages; a feature package cannot share its own row component with another feature package.

### The turn rail sits at the start edge

The turn rail sits at the scrollport's start edge with its marks, focus ring, and preview mirrored, leaving the end gutter to the docked panel; its 900px hiding rule guarantees room beside the start-side width handle.

## Alternatives considered

- **A right-sidebar tab.** It already exists for change requests, but it narrows the transcript while shown, shows one tab at a time, and the [UI guidance](../../../skills/dsh-client-ui-ux/SKILL.md#reuse-before-adding) reserves the sidebar for content opened on demand rather than a resident summary.
- **The dock kit's floating window.** `FloatLayer` windows are draggable, resizable, and positioned in viewport coordinates; a summary anchored to the transcript gutter needs none of that and would have to fight the window's own placement rules.
- **Viewport-width breakpoints.** The transcript width is adaptive and draggable and the right sidebar takes a variable track, so a viewport breakpoint either covers the transcript or hides the panel with room to spare.
- **CSS-only hiding with a click-time read.** A container query on the gutter can hide the docked panel, and the toggle could read the computed result when pressed, as the background-job trigger does. The toggle would still render without knowing whether the panel shows, so `aria-expanded` and its tooltip would be wrong whenever the preference says dock but the gutter is too narrow.
- **Squeezing the transcript to make room.** Docking on laptop widths by moving the transcript column aside changes the centered column, the composer, and both width handles; it remains a separate layout decision.
- **A Session-scoped standard hook for the layout.** Adding `useConversationLayout` to every Session-scoped Slot made every component fixture in the client restate it; the layout has two readers, so a source on the existing Conversation service serves them without widening the standard props.

## Consequences

- With the default transcript width the body must be about 1608px wide to dock, so laptop widths use the overlay; the panel never covers the transcript unless the user opens it.
- Sections from independent plugins share one surface, ordering, and title style without depending on each other, and an occupied section id can be replaced by a higher-priority registration.
- The Conversation width controls gained one callback and the Conversation service one per-Session source; the composer stack height now lands on the content body so chrome outside the scrollport can read it.
- The turn rail's position changed for every user; its behavior and hiding rule did not.
- Change requests, background jobs, and subagents became sections, replacing the change requests sidebar tab, its start-page entry, and the header controls of jobs and subagents; the header keeps the subagent breadcrumb switcher for child Sessions. A section mounts only while the panel shows, so state that must outlast hiding the panel, such as cleared job rows, lives in a per-Session slot store.
