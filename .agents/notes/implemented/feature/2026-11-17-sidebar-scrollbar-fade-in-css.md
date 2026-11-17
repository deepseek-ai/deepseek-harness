# Agent Note: The sidebar scrollbar's delay and fade live in a CSS transition

Status: implemented

English | [中文](2026-11-17-sidebar-scrollbar-fade-in-css.zh.md)

## Problem

The sidebar draws its scrollbar thumb only while the pointer is over the column. [The pointer-revealed scrollbar note](../../archived/feature/2026-08-04-pointer-revealed-sidebar-scrollbars.md) shipped this with a 2-second JavaScript timer after the leave, and the thumb then vanished in one step. Product review asked for a 500ms hold followed by a visible fade (Issue #7921). That note rejected expressing the delay as a CSS transition; this note reverses that rejection.

## Decision

ui-theme registers `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover` with `@property` as inherited `<color>` properties whose initial value is `transparent`, so a rebinding of the pair can be transitioned. `SidebarRoot` adds `quietBars` as soon as the pointer is outside the column box and keeps no timer. The `.root.quietBars` rule rebinds both properties to `transparent` with `transition: … 200ms linear 500ms`. The base `.root` rule declares no transition, so a reveal is immediate, and a pointer that returns during the delay removes the class before the colour moves. Under `prefers-reduced-motion: reduce`, the quiet rule sets `transition-duration: 0s`: a zero duration with a non-zero delay still starts a transition, so the thumb holds for 500ms and then switches in one frame.

The transition runs on the column's custom property, not on a scrollbar pseudo-element. The WebKit thumb's `background: var(--dsh-scrollbar-thumb)` and Firefox's per-element `scrollbar-color` read the property's current animated value at each style update. In Chromium, `apps/web/tests/sidebar-scrollbar.e2e.ts` samples the resolved colour once per animation frame and sees the hold followed by the fade; with the reduced-motion rule removed, the reduced-motion case observes intermediate colours and fails.

The fade is linear over 200ms, the timing SimpleBar uses. An eased 100ms fade of this pale thumb completes most of its change within a few frames and reads as a cut.

Inside or outside is decided by the column's box on every `pointerenter` and `pointermove` that reaches the column, because the Settings panel is a fixed-position descendant and the column's menus are React portals: a pointer over them fires no `pointerleave` here while their moves still bubble to the column. The column's own `pointerleave` covers a pointer that leaves the window.

## Alternatives considered

**Keep the JavaScript timer and add only a CSS fade.** It needs the same `@property` registration for the fade and keeps a timer, its cancellation, and unmount cleanup in the component. Moving the delay into `transition-delay` removes that state and keeps both timings in one declaration.

**Leave the properties unregistered.** An unregistered custom property switches in one step, so no transition can hold or fade the colour.

**Draw an app-owned thumb element and fade its `opacity`.** It gives any fade curve in every engine and costs hit-testing, dragging, wheel, momentum, and hover styling of a replacement scrollbar, which the pointer-revealed scrollbar note already rejected for a cosmetic gain.

**Hide the bar with `scrollbar-width: none` or `display: none` on `::-webkit-scrollbar`.** It releases the reserved gutter, so revealing the bar would shift every row sideways.

## Consequences

The registration is global: every surface that reads the pair now inherits a computed `<color>` instead of the token text, and a value that is not a colour falls back to `transparent` rather than leaving the declaration invalid. Only `.root.quietBars` declares a transition, so other surfaces change neither timing nor colour; the scrollbar geometry golden is unchanged in both palettes.

The component lost its timer, its document-level listener, and their cleanup. The delay and duration are stated once in the stylesheet, and `scrollbar-quiet-styles.client.spec.ts` pins the exact `transition` value.

The fade is verified only in Chromium. Safari renders through the same WebKit pseudo-elements; if it does not repaint the thumb during the transition, the thumb holds and then disappears after about 700ms, so the delay still applies without a visible fade.

A leave during a sidebar collapse or expand hides the thumb at once, because the collapse rule's `transition: width` declaration takes precedence over the quiet rule's.
