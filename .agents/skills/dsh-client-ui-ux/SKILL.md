---
name: dsh-client-ui-ux
description: Use before implementing any DSH user-visible UI change and during UI review, including layout, copy, icons, styling and interaction states in client, experimental and app packages. Select applicable rules before coding and verify the affected rendered relationships before handoff.
---

# DeepSeek Harness UI development

Use this entry before changing UI. It owns the development workflow, visual foundation, component geometry, and interaction guidance; linked owners supply specialized design rules. Apply the guidance to the user task, not as an exhaustive checklist. Existing repository rules and named exceptions govern values; cases explain judgment and do not define coverage.

## Required review loop

Layout, copy, icons, styling and interaction changes trigger this loop without a separate review request. Behavior-only edits include affected loading, error, disabled, expanded and focus states. Documentation-only changes and refactors with evidence of unchanged rendering do not need new captures; state that basis.

1. **Before coding, make the design decisions.** Name the user task, affected page or modal, semantic groups, shared alignment references and intended group separation. Select existing components and variants, read applicable owners below, and identify relevant states and consumers using the [impact scope](../../../docs/cookbook/reviewing-ui-design.md#review-scope). Record these choices and planned evidence in a few task-note sentences. Preserve starting source and images; uncommitted UI is not represented by `HEAD`. New UI can use a sketch and established sibling as its starting reference; label them honestly.
2. **Implement using those decisions.** Reuse the selected components and existing values. Check group structure and shared axes before optical detail. Expand scope when a shared consumer, neighbor or state can change. Batch coherent edits before recapturing; do not run a full-product audit for each CSS change.
3. **Before completion, inspect the final rendered result.** Verify affected relationships and behavior in the assembled page or modal, retain comparable before/after evidence for changed positions, and run relevant repository checks. Distinguish inspected, equivalent-by-evidence, unresolved and uninspected scope. Missing required scenes, unresolved defects or failing checks prevent a complete-validation claim; state the gap and next verification.
4. **Before PR or push, reconcile the cumulative diff.** Check overlapping edits and missing coverage. Reuse evidence while source, dependencies, content, states and capture conditions remain valid; rerun only invalidated or missing checks. Deliver scope, decisions, evidence, results and material gaps.

Keep the record in the task or local artifacts, not a new tracked checklist per edit. Load applicable owners once while unchanged; retrieve examples only for uncertain decisions. Choose conditions by risk, not every width × theme × state combination or a fixed screenshot count. The [review cookbook](../../../docs/cookbook/reviewing-ui-design.md) owns detailed evidence procedures. Tool success does not judge visual quality.

## Select the rule owners

For layout and grouping changes, read alignment and spacing directly before positioning elements. For other changes, read their applicable owners and preserve existing relationships. Each row has one responsibility; do not copy numeric scales between them.

| Decision needed before implementation | Owner |
|---|---|
| Shared axes, text starts, centering, tree indentation, complete icon boxes | [Alignment](../dsh-ui-alignment/SKILL.md) |
| Semantic groups, inner/outer gaps, repeated rhythm, section separation | [Spacing and grouping](../dsh-ui-spacing/SKILL.md) |
| Interface icon selection, drawing, supplied-artwork normalization, style, optical weight, icon/label color | [Icons](../dsh-ui-icons/SKILL.md) |
| Color, typography and existing treatments | [Visual foundation](#visual-foundation); [Web styling](../../../docs/web-styling.md) owns tokens/materials |
| Component geometry, nested contours and state fills | [Geometry decisions](#component-geometry); [radius standard](../../../docs/ui-radius.md) owns values and exceptions |
| Feedback lifetime, loading, overlays, scrolling and platform clearance | [Interaction and feedback](#interaction-and-feedback); [error handling](../dsh-error-handling/SKILL.md) owns failure guarantees |
| Space allocation, truncation, input capabilities and retained focus | [Responsive UI](../dsh-responsive-ui/SKILL.md) |
| Official plugin artwork and feature previews | [Official artwork](../dsh-official-plugin-artwork/SKILL.md) |
| Copy, locale ownership and component semantics | [Prose standard](../dsh-prose-standard/SKILL.md), [locale ownership](../../notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md), [primitives catalog](../../../packages/client/ui-primitives/README.md#component-catalog) |
| Density, information hierarchy, combined control states and component choice | [Principle reference](../../../docs/ui-design-review-cases.md#density) sections 3–6 |

## Reuse before adding

Extend the existing component, container or interaction when the new capability fits it. An extra menu item or primitive prop usually belongs in that owner. Right-sidebar content registers in the existing sidebar. Reuse existing icons first; follow the [icon owner](../dsh-ui-icons/SKILL.md#reuse-existing-icons-first) to decide when a new drawing or normalization is needed.

Before restructuring components, read [client instructions](../../../packages/client/AGENTS.md) and [client defensive patterns](../../../docs/defensive-patterns/client-components.md) for slots, props, state flow, effects and layering.

## Visual foundation

- **Use existing tokens for color, radius, and spacing.** Before introducing a literal value, search the target page and its nearest established sibling (the Plugins page is the usual reference for full-page surfaces) for the token or value already in use, and adopt it. The same applies to whole treatments — toasts, menus, in-message artifact previews, sidebar tab layout, colors, clearance rules, page padding: reuse the established component or rule wherever one exists instead of inventing a parallel one.
- **Verify every color in both light and dark mode.** An ink/background pair must stay readable under both themes before it ships. Dimmed tones are the standing counter-example: they suit decorative surfaces, but on text they routinely fall below readability in one theme — never put a dimmed color on text without checking both.
- **Font weight tops out at 500 in feature CSS you add or change.** Do not use 600+ for emphasis; differentiate with size or ink instead. The markdown typography tokens owned by ui-theme are the standing exception.
- **Pick font sizes from the theme typography variables when an existing role matches, otherwise from the page's existing scale.** Parallel content shares one size; never invent a size for a single element, and keep the number of distinct sizes on a page small (13px is the established row/detail size). When the page itself has no precedent, borrow the size and spacing ratios of the most similar existing page or element.
- Apply [alignment](../dsh-ui-alignment/SKILL.md) and [icons](../dsh-ui-icons/SKILL.md) to icon/text relationships.

## Component geometry

Choose the component's role, reuse its size variant, then identify how it relates to its container. Compare height, radius, curve, inset and visible material together. Equal radius values alone do not make neighboring controls coherent; wrapping or expansion alone does not select a larger radius. Use the [radius scale and component exceptions](../../../docs/ui-radius.md#radius-scale) for actual values.

- **Inset surface:** coordinate the inner curve with the outer curve and inset. Radius subtraction gives concentric circular arcs; for superellipses it is a nominal sizing rule, so inspect diagonal whitespace as well as the side gap.
- **Flush fill or adjoining segments:** let the enclosing surface own exposed corners and keep internal joins square. Hover fills and pseudo-elements follow that contour. Keep menus outside clipping and retain visible keyboard focus.
- **Independent child card or form group:** choose its own role and size tier. Do not subtract all parent padding or give it the enclosing dialog's radius.
- **Circles and capsules:** preserve their intended shape, including both an avatar container and its image. Follow the theme's round-curve exception; ordinary controls use the shared curve.

Keep geometry stable across hover, pressed, selected, loading and disabled states. Compare fills, strokes and overlays with the same silhouette. Use the existing [card and elevation materials](../../../docs/ui-radius.md#settings-cards); an elevation shadow already includes its neutral hairline, so adding another border doubles the edge. Preserve semantic state-colored borders.

Inspect related controls together at actual size, including small selection controls, in the affected themes and states. Check longer labels and narrow layouts when they change the composition. Existing radius, curve and elevation checks catch unsupported declarations; rendered comparison establishes whether the chosen values fit. The [geometry cases](../../../docs/ui-design-review-cases.md#geometry) illustrate this judgment. These decisions guide changes in scope; they do not call for a bulk restyling of existing components.

## Interaction and feedback

### Feedback surfaces

Apply [dsh-error-handling](../dsh-error-handling/SKILL.md#localized-actionable-visible-reports) to failure reports. Choose the surface by the lifetime of the message relative to the surface that produced it:

- **Transient operation outcomes use the app-wide Toast primitive**, not in-place notices, and the toast's state and rendering live in a host that outlives the reporting surface (a `shell.overlay` entry, as RowActionToast does) — a toast rendered by the panel itself unmounts with that panel. A deletion can close the panel or tab that requested it; only a toast held outside that surface survives the close. Report success and failure; do not report still-pending states.
- **A failed operation keeps the data visible.** A failed deletion keeps its row; the toast announces the failure. Never blank content to show an error for a transient operation.
- **In-place notices are for states tied to the surface itself**: a query failure with its Retry action, field validation on the form that owns the field. A populated panel keeps a compact notice beside its retained content; only an empty panel centers a full error state.
- **Error copy is plain language, and short.** No internal jargon or technical nouns unless an error code must be exposed for debugging. Prefer one clear sentence; anything explainable in two sentences must not grow into paragraphs. A Chinese notice of at most two sentences omits the trailing 句号（。）. The notice must not break the existing layout — reserve its space or overlay it; never shift neighbouring elements.

### Loading states

- Lists use their skeleton; every other page-level load centers a bare spinner. Never place a spinner in a corner of the page.
- One loading treatment per page/component — concurrent regions must not each flash their own style.
- No loading text unless the context needs it (narrow sidebars almost never do).

### Overlays and menus

Every menu, popover, and tooltip must be verified for all three before merge:

- **Dismissable**: outside click (and Escape where focusable) closes it.
- **Viewport-fitting**: it slides or flips to stay inside the window with an edge margin, and flips only into a side that actually fits (no oscillation when neither side fits).
- **Unclipped**: it escapes `overflow` ancestors and containing blocks (portal to body where needed) and is never covered by neighbouring elements.

Scrollbars stay inside their container: use the shared scrollbar styles rather than component-specific selectors, and verify the bar neither overflows the container nor gets clipped by its rounded corners or edges — keep a small inset instead of letting it sit flush against the container edge.

### Platform window adaptation

- Any new header element or full page must account for macOS and Windows window chrome. On macOS the titlebar clearance is `--dsh-frame-top-clearance`, consumed by Menu, Modal, and overlay primitives as their top safe margin — **never change the global variable to fix one page**. Add a scoped `[data-platform='darwin']` override on the page's own inset instead, and assert the override in the page's stylesheet spec.
- State the intended total offset (clearance + page inset) when reviewing, so two pages aligning to "the same top spacing" agree on the sum, not just one addend.

## Check the rules together

Inspect the whole composition for context, then the affected cross-group and internal relationships, including distant peers and relevant expanded content. Match both endpoints of each shared axis. Compare complete icon boxes before optical adjustment; keep group separation clear. Geometry must preserve popup and focus visibility; spacing must retain field feedback; narrow layouts must retain actions and drafts. Inspect theme material and platform backdrop where affected. Full-interface claims require all their regions; a fixture or crop establishes only what it renders.

## Maintain one owner per rule

Update the existing owner when a principle changes. Add a focused skill only when it makes a distinct implementation decision; otherwise extend an existing section or reference. Add one routing row here only for a new responsibility. Keep examples in the [case reference](../../../docs/ui-design-review-cases.md), linking to the owner instead of copying its rules. AGENTS files and PR workflows link to this loop and do not repeat its checklist.

For a rule change, state applicability, decision, exceptions and observable verification in its owner; add or update a case that distinguishes a valid result from a plausible wrong fix. Search other owners for superseded statements. Declare whether existing consumers are being migrated or only future edits must comply. Rule edits do not establish that existing UI already conforms. Add a deterministic gate only for a mechanically decidable invariant; rendered judgment remains part of the development loop. Local review tools read these repository owners and retain the reviewed source and rule revisions; they do not maintain a second standards copy.

## Design review escalation

Obtain designer or product review before landing new pages or interaction patterns, broad shared-component or global visual changes, and unresolved design tradeoffs. Routine local corrections use this loop without another human checkpoint. Explicit independent reviews and periodic human audits can widen scope and feed recurring misses into owning rules; neither replaces development-time decisions or creates an automatic schedule.
