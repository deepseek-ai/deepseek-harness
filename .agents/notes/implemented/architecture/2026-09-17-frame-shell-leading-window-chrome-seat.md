# Agent Note: Frame-owned shell.leading window-chrome seat

Status: implemented

English | [中文](2026-09-17-frame-shell-leading-window-chrome-seat.zh.md)

## Problem

The [macOS hidden-titlebar work](../feature/2026-09-13-macos-hidden-titlebar-vibrancy.md) hid the collapsed sidebar column entirely on darwin and moved the reopen and New Session controls into a conversation-header slot (`conversation.session.header.leading`), shown via CSS while `data-sidebar-collapsed` was published. Only the Conversation had that seat: with any other main panel selected (the plugin manager, or any future global panel), a collapsed window kept the floating traffic lights over the panel's content with no reopen control anywhere on screen. Each new panel would have had to grow its own leading seat and repeat the same clearance geometry.

## Decision

The window chrome belongs to the frame, not to one panel. ui-layout declares a fifth root-scoped child slot, `shell.leading` (single), and AppFrame renders its seat as a frame-level box over the columns — mounted only on the darwin desktop while `sidebarCollapsed`, the full-hide state that leaves window chrome without a home (Windows' zero-width collapse keeps its fixed caption controls, so the seat must not mount a second set there). The seat sits at the frame's top-left (left 88px clears the hiddenInset traffic lights, top 11px centers the 28px controls on the conversation title row, z-index 15 above column content and below frame overlays) and carries `-webkit-app-region: no-drag`, subtracting itself from any drag band beneath it.

Under the same collapsed condition the frame publishes `--dsh-frame-leading-clearance: 160px` — the inline band the traffic lights plus the seat's two controls occupy, measured from the frame's left edge. Window fullscreen hides the traffic lights (the desktop preload mirrors the state onto `html[data-fullscreen]`): the seat moves to `left: 12px` into their vacated band and the clearance drops to `84px`. The conversation title row is the one consumer: it pads `max(0px, clearance - 20px)` (its header already pads 20px). Entry pages that start below the window strip in both sidebar states (the plugin manager's page head) instead pad their top by `--dsh-frame-top-clearance` (48px, published on the darwin frame unconditionally), which clears the strip vertically rather than indenting inline.

ui-sidebar registers `HeaderLeadingControls` into `shell.leading` instead of the conversation seat, reusing the shell's inject face and locale; the component renders unconditionally because the frame owns the mount condition, and its platform check and CSS collapse-gating are deleted. This also drops ui-sidebar's dependency on ui-conversation. The original `conversation.session.header.leading` slot is gone per the pre-stable API rule (every consumer updated, no compatibility shim); the conversation header now exposes its own sessionless `conversation.header.leading` seat (root-scoped, rendered without a Session) as a public extension point, empty in the shipped composition because the window-chrome controls live in `shell.leading`.

## Alternatives considered

**Keeping the conversation seat and adding one per panel.** Every main panel would repeat the seat markup, the drag-region subtraction, and the traffic-light geometry, and a panel that forgot would strand a collapsed window without a reopen control. One frame-owned seat makes the guarantee structural.

**Mounting the occupant always and gating visibility in CSS (the prior mechanism).** This kept dead DOM and a no-drag subtraction in the header on every platform and every collapse state, and it could not help non-conversation panels at all. A frame-level TSX mount keeps the condition, the seat geometry, and the clearance publication in one file.

**Gating the seat on rightbar fullscreen as well.** Unnecessary: the fullscreen right panel (z-index 40) covers the seat (15) visually, and it already opts its whole box out of window dragging, so the seat's geometry cannot puncture it.

**Publishing clearance as a fixed padding each consumer hardcodes.** A raw `160px` in each panel would silently desynchronize from the seat's real band; one custom property published under exactly the mount condition keeps consumers correct when the geometry changes.

## Consequences

- Every current and future main panel keeps the reopen and New Session controls while the sidebar is hidden, at zero per-panel cost; the conversation opts into `--dsh-frame-leading-clearance`, and entry pages take the unconditional `--dsh-frame-top-clearance` instead.
- `conversation.session.header.leading` no longer exists in the client catalog; `shell.leading` carries the window chrome as a public root-scoped seat, while the conversation header's sessionless `conversation.header.leading` remains a separate public seat with no shipped occupant.
- ui-sidebar no longer depends on ui-conversation (inject list, devDependency, and tsconfig reference removed).
- The mount condition names darwin explicitly: Windows' `data-windows-titlebar` collapse also yields a zero-width column but keeps its own fixed caption controls, which a frame seat would duplicate. A platform that later hides its column without leaving its own chrome opts in by widening the condition.

## Testing

The ui-layout app-frame spec pins the seat's mount and unmount across the darwin collapse and its absence beside the 56px rail; the apply spec pins the five-slot declaration and teardown. The ui-sidebar apply spec pins the `shell.leading` registration (component, locale, shared inject face) and its removal on dispose; the sidebar-root spec pins the two controls' actions.
