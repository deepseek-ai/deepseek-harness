# Web UI style reference

English | [中文](web-styling.zh.md)

This reference defines styling ownership and component rules for browser client packages. The current token values live in [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/); this document does not duplicate that generated-by-source inventory.

## Ownership

[`ui-theme`](../packages/client/ui-theme/README.md) owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`](../packages/client/ui-layout/README.md) applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.

Global style sheets belong in `ui-theme/src/styles/`. Component styles live beside their component as CSS Modules. A component may define a local custom property when its value is part of that component's layout or presentation contract; shared colors, typography, elevation, and motion belong to the theme package.

## Component rules

- Use CSS Modules and `clsx`; do not add a component library or Tailwind.
- Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
- Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
- Pair font sizes with line heights and use the theme typography variables when an existing role matches.
- Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
- Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
- Preserve keyboard focus visibility and reduced-motion behavior when adding transitions or hover-only controls.
- Rounded corners inherit the global superellipse smoothing from ui-theme's `corner-shape.css` on supporting engines. Pair `corner-shape: round` with every full-round `border-radius` (`50%`, `100%`, or a pill radius) so circles and capsules keep circular arcs; the ui-theme corner-shape spec enforces the pairing.
- Elevated surfaces (menus, popovers, modals, panels, floating buttons, the composer) set `border: 0` and take `box-shadow: var(--dsw-elevation-panel)`, `var(--dsw-elevation-prominent)`, or the composer's `var(--dsw-elevation-soft)` (larger blur at lower alpha): the 0.5px hairline stroke is the first shadow layer, and `--dsw-elevation-stroke-color` rebinds or suppresses it per surface or state. Never pair a `--dsw-alias-border-*` border with an lv/elevation shadow — the ui-theme elevation spec rejects the pairing; state-colored borders (warn panels) stay real borders.
- Flat borders and separators that use a neutral `--dsw-alias-border-*` token draw at `0.5px` — buttons, inputs, cards, row dividers, and separators drawn as filled boxes (menu separators, the conversation header seam, markdown `hr`, vertical rails) share the hairline weight, which Chromium paints as one device pixel. Dashed affordances and state-colored borders keep 1px; spinner ring tracks keep their width through the spec's explicit allowlist. The ui-theme elevation spec rejects wider neutral solid borders.

## Changing the system

Add or change a shared token in the owning `ui-theme` sheet, then consume its semantic alias from feature packages. Update the owning package reference when a public styling contract changes. Visual behavior follows the [testing policy](testing.md); the [styling-system Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) records framework rationale.
