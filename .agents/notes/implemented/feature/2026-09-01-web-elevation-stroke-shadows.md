# Agent Note: Web elevation — hairline stroke drawn in shadow

Status: implemented

English | [中文](2026-09-01-web-elevation-stroke-shadows.zh.md)

## Problem

Elevated web-client surfaces — menus, popovers, modals, panels, floating buttons, the composer — each paired a real `border: 1px solid <neutral token>` with a `--dsw-shadow-lv2`/`lv3` shadow. The border consumes layout (1px per side, and it is the UA-default replacement on `<button>` elements), the light theme drew most floats with no stroke at all (`--dsw-alias-border-inverted` is transparent in light) while `lv3` faked one with a blurred 1px ring, and the composer wore a broad soft `lv2` patch that read as a smudge rather than a lifted surface. Current desktop chat UIs instead draw elevation as one `box-shadow` list: a 0.5px hairline stroke plus two faint soft layers, with `border: 0` on the surface.

## Decision

`gradient-shadow-text.css` (the ui-theme shadow owner) defines the elevation tokens beside the `--dsw-shadow-lv*` scale:

- `--dsw-elevation-stroke-color` — the hairline color, defaulting to `--dsw-alias-border-l4` (black 16% light, white 20% dark); components rebind it per surface or state: every menu-fill surface (`--dsw-specific-menu` background) rebinds the lightest `--dsw-alias-border-l1` and the composer rebinds `--dsw-alias-border-l2`, both quieter than panels and buttons. The default is declared on `body` alone while the derived tokens below are re-declared on `body, body *`: a custom property computes with `var()` already substituted, so body-only derived tokens would bake in body's color and make every rebind a no-op (the same per-element re-substitution scrollbar.css states for `--dsh-scrollbar-thumb`).
- `--dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color)` — the stroke alone, used standalone by inline cards that want only an outline (the plugin-inventory card).
- `--dsw-elevation-panel` / `--dsw-elevation-prominent` — the stroke plus two faint soft layers (3px directional + 16/20px glow at 2–5% black), panel for small floating widgets and cards, prominent for floats, and soft — larger blur at lower alpha — for the composer.

Converted surfaces set `border: 0` and one elevation shadow: every `--dsw-shadow-lv3` float (Menu, Modal, popup selects, model select, usage/context popovers, feedback actions, schedule/job popovers, subagent lineage, settings panel, cordis panel, experimental team panel) takes prominent, and the lv2 surfaces (scroll-to-bottom button, turn-preview card, attachment-rail arrows, question composer, trajectory tooltip) take panel. The composer card takes the soft tier with the l2 stroke rebind, and its workspace-trigger state sets the stroke color `transparent` instead of the former `border-color: transparent`. Dark theme needs no shadow overrides: the soft layers are near-invisible there and the stroke carries the separation.

`packages/client/ui-theme/tests/elevation-styles.client.spec.ts` pins the token composition and scans every stylesheet under `packages/`: a rule pairing an lv/elevation `box-shadow` with a `--dsw-alias-border-*` border fails, and every `solid` border on a neutral `--dsw-alias-border-*` token must be `0.5px` wide. Deliberate keeps: Toast and HoverCard (inverted fills where a theme-following stroke is meaningless), ImageLightbox (bare image), and the warn-bordered approval/plan panels, whose state-colored borders stay real borders and pass the scan.

Flat widgets keep real borders at hairline width: every neutral-token `1px solid` border — buttons (the shared outline variant, add/retry/inspect buttons), inputs, inline cards, code blocks, and the settings row separators — is `0.5px solid`, with full-box strokes deepened to `--dsw-alias-border-l4` (buttons one step lighter at `--dsw-alias-border-l3`) while row separators keep `--dsw-alias-border-l2`; state logic (`border-color` swaps on focus/hover) is unchanged. Separators drawn as filled boxes take the same weight: the 1px-tall or 1px-wide lines with a border-token background (menu separators, the conversation header seam, markdown `hr`, the tool IO dividers, the trajectory rail, the directory-browser divider) are 0.5px, and the context-injection divider that read the never-defined `--dsw-alias-line-secondary` (so it never rendered) now draws `0.5px solid var(--dsw-alias-border-l2)`. Chromium paints sub-device-pixel borders as one device pixel, so 1x displays render exactly the former line and 2x displays get the hairline. Dashed affordances stay 1px (a 0.5px dash pattern degrades), and the two border-drawn spinner rings keep their track width through the spec's explicit allowlist.

## Alternatives considered

**Keeping 1px real borders and only softening the shadows.** Leaves the layout-consuming border, the light-theme stroke gap on `border-inverted` floats, and the double outline wherever both existed; the stroke-in-shadow form is what produces the crisp hairline edge.

**A 1px stroke instead of 0.5px.** At 2x displays 0.5px renders one physical pixel, and on 1x it blends lighter, which is the intended hairline. 1px reads as the old border.

**Drawing flat-widget hairlines as box-shadow strokes too.** Buttons and inputs swap `border-color` on hover and focus and several pair a box-shadow focus ring; moving their stroke into `box-shadow` would collide with those rings (one property) and rewrite every state rule, while `0.5px solid` keeps the whole state logic and changes only the weight.

**Suppressing the composer trigger stroke with `box-shadow: none`.** Also drops the soft layers the trigger state keeps today; rebinding `--dsw-elevation-stroke-color: transparent` removes exactly the stroke.

**Converting Toast/HoverCard too.** Their fills are inverted relative to the theme, so the theme-following stroke color is invisible-or-wrong on them; they keep `lv3` until an inverted-surface stroke token exists.

## Consequences

- Every converted surface gains a hairline outline in the light theme (most floats previously had none) and loses 1px of border from its box; the visual size change is at most 2px on small buttons and imperceptible on panels.
- The neutral-border-plus-shadow pairing is now rejected by the ui-theme elevation spec, so a new elevated surface must choose the elevation tokens; the rule lives in [docs/web-styling.md](../../../../docs/web-styling.md).
- The composer's broad `lv2` patch becomes stroke + tight glow; its dark stroke keeps the figma one-notch-weaker value through the rebind.
- `--dsw-shadow-lv1`/`lv1-blur` currently have no consumer and `lv2`/`lv3` remain only on the deliberate keeps; the scale stays for inverted and bespoke surfaces.
