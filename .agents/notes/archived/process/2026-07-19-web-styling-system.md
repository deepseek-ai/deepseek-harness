# Agent Note: Web styling system — the token framework and engineering constraints

Status: implemented
Archived: 2026-09-30

> Token-system update (2026-07-22): the framework rulings here (CSS Modules + clsx, no component library, no tailwind, tokens-only colors) remain in force, but the two-layer `--bg-*`/`--text-*` token table and its `web-ui/src/style/global.css` home were replaced by the `--dsw-*` static+alias sheets in `packages/client/ui-theme/src/styles/` (dark = `body[data-ds-dark-theme]` override) — the sheets themselves are the token authority.

English | [中文](2026-07-19-web-styling-system.zh.md)

> Division of labor: this RFC fixes the framework and constraints (rarely changes); [docs/web-styling.md](../../../../docs/web-styling.md) is the living spec (authoritative token values, the coding-rule checklist, the deviation record — it evolves with the implementation). Token changes and new rules go there; only changes to the framework itself come back here (overturning it requires a new RFC).

## Problem

The GUI has no designer supply; styles are written by an agent and reviewed. Without a machine-checkable token system and coding rules, colors/radii/motion drift as literals across components, and dark mode grows into conditional branches scattered inside components.

## Decision

| # | Decision | Content |
|---|---|---|
| 1 | **Visual baseline = Chat alignment** | Every value comes from the Chat front-end survey (brand blue `--accent: #3964fe`, gray scale, bubble/sidebar geometry, shadow tiers…); deviation is allowed but must be recorded in the web-styling.md deviation table |
| 2 | **Two token layers, not three** | The baseline repo uses static→alias→specific three layers; at our size this compresses to "a semantic layer holding real values directly (comments cite the base palette source) + a handful of component-specific slots (`--bg-sidebar`/`--bubble-bg`)" — two layers, all living in `web-ui/src/style/global.css` |
| 3 | **Font sizes/spacing are not tokenized** | Same decision as the baseline repo: font sizes are written in px inside components and **always paired with a line height** (16/24, 14/22, 12/18); spacing uses multiples of 4; tokenization covers only colors/radii/motion/font stacks/shadows |
| 4 | **Borders and interaction states use the opacity scheme** | Borders `rgba(0,0,0,.04/.1)`, hover/active `rgba(38,49,72,.06/.1)` — they hold when layered on any elevation background, no new solid grays |
| 5 | **Dark mode happens only in the token table** | `:root` holds light real values + `[data-theme='dark']` overrides the same-named variables; **component CSS has zero theme selectors**; when a non-token value genuinely must vary by theme, use the "CSS variable bridge" (the component defines a local variable, the theme block only overrides the variable) |

## Engineering constraints

- **CSS Modules + clsx, no component library, no tailwind**: each component has a same-named `.module.css` in the same directory; class names are camelCase, single-adjective state classes are attached via clsx; components pass `className` through.
- **`composes` is banned**; `:global` only pierces third-party/cross-package class names and never defines new global classes; global utility classes live only in global.css and stay in the single digits (currently `.scrollable`).
- **PostCSS plugins are currently zero** (vite has no postcss config; flat CSS suffices — adopting nested/custom-media requires recording it in web-styling.md first); CSS Modules type declarations use the wildcard declare in `css-modules.d.ts` (re-evaluate typed-css-modules per-file generation past 20 components).
- **Dynamic styles go through the CSS variable bridge**: JS writes only variables (`style={{'--x': v}}`), rules stay in CSS; assembling style objects in TSX for theme/state branches is banned.
- Transitions are always `var(--dur*) var(--ease)` and only transition opacity/transform/background-color/shadow; scroll containers uniformly use `.scrollable` (writing `::-webkit-scrollbar` inside components is banned).

## The execution shape for agents

The spec is maintained as a **review checklist** (web-styling.md §3, 12 items): each item is a decidable "see X, reject" — not a style suggestion — and writing styles and reviewing styles share the same table.

Entry points for common tasks (operational checklists):

- **Styling a new component**: same-named `.module.css` in the same directory, self-check against web-styling.md §3 item by item; colors/radii/motion reference only §1 tokens.
- **Adding a token**: first add a row to the web-styling.md §1 table (light value + dark column + base palette source comment) → update both the global.css `:root` and `[data-theme='dark']` blocks → only then reference it in a component.
- **Deviating from a visual-baseline constant** (the geometry/shadow values of web-styling.md §2): record a row in the §5 deviation table first (date/item/reason), then land the code.
- **A non-token value that must vary by theme** (gradient endpoints and the like): the component defines a local CSS variable and the theme block only overrides the variable (the variable bridge); component CSS keeps zero `[data-theme]` selectors.

## Division of labor with web-styling.md

| Content | Home |
|---|---|
| The five framework rules, engineering constraints, why two layers / why font sizes are not tokenized | This RFC (changing it = a new superseding RFC) |
| Per-token authoritative values (dark included), visual-baseline constants (sidebar/bubble/session-row/input-card geometry), the RPC four-quadrant direction-marker visual vocabulary, the 12 coding rules, the deviation record | web-styling.md (living document, evolves with the implementation) |
| Value evidence (deepseekchat file:line) | The survey archive has served its purpose; git history keeps it |

## Consequences

Styles converge machine-checkably: colors/radii/motion/shadows reference only the §1 tokens of web-styling.md, dark mode is a single attribute-selector override table, and review runs off the same 12-item checklist the author self-checks against. The cost accepted: font sizes/spacing rely on the paired-line-height and multiples-of-4 disciplines rather than tokens, and any framework change requires a superseding RFC.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Tokenizing font sizes/spacing | The baseline repo demonstrates convergence without it (the paired-line-height discipline substitutes); a bloated token table dilutes the authority of the color tokens |
| Dark mode via `prefers-color-scheme` or in-component branches | Attribute-selector whole-table override keeps components oblivious; system preference can be layered onto the toggle later without touching the token mechanism |
