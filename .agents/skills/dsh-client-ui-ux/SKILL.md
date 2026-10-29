---
name: dsh-client-ui-ux
description: "Design and review DSH user-visible UI: alignment, spacing, icons, visual foundation, geometry and interaction. Use before UI changes in client, experimental and app packages; verify affected rendered results before handoff."
---

# DeepSeek Harness UI development

Use this skill as the entry point for UI design and review. It owns the workflow, visual foundation, geometry and interaction guidance; alignment, spacing and icon details live in its references below. Load only the references relevant to the task; examples explain judgment, not coverage.

<a id="required-review-loop"></a>
## UI change workflow

Use applicable design rules for UI changes, including visible loading, error, disabled, expanded and focus states. Choose effort by impact and regression risk; ordinary development does not require a full design audit.

| Change | Required inspection | Additional records |
|---|---|---|
| Local copy, icon reuse, color or spacing | Inspect the actual page, affected neighbors and relevant states; run applicable tests. Apply the minimum checks below. | Briefly report results and material gaps. No separate plan, axis drawing, scene inventory, source snapshot or screenshot report is required by default. |
| Page layout, shared components or global styles | Identify affected relationships and consumers; inspect distinct affected layout, content and state variants in assembled pages. Reuse evidence only for justified equivalents. | Briefly state scope. Preserve the starting version and comparable images when requested or needed to explain broad changes or assess regression risk. |
| Explicit comprehensive review | Cover the agreed regions and relevant states; distinguish inspected results, defects and uninspected scope. | Use the [review cookbook](../../../docs/cookbook/reviewing-ui-design.md) for coverage records, findings and supporting evidence. A comparison request alone does not require a product-wide audit. |

### Minimum checks for affected UI

These checks apply even to small changes; optional documentation does not make inspection optional. Open the actual page and inspect the changed element with its directly affected neighbors, rather than judging CSS or an isolated component alone.

- **Color or opacity:** inspect light and dark themes, including affected foreground/background and state combinations.
- **Layout, spacing, typography or sizing:** inspect a constrained container and long or wrapping content; check both sides of a changed breakpoint, alignment, clipping and access to actions.
- **Interaction:** exercise the changed path and affected focus, disabled, loading, error, expanded and overlapping states. Check only states the change can affect, not every possible combination.
- **Shared components or global styles:** trace affected consumers and inspect distinct assembled layouts and states; one isolated example cannot establish coverage.

If a required scene is unavailable, state what was not checked, why and how it can be verified; a labeled production-component fixture can provide partial evidence, not an actual-page pass. Do not claim verification complete while required checks remain missing. Run the original applicable tests; source inspection and passing tests alone do not establish the rendered result.

Read unchanged owners once; consult examples for uncertain judgments. Inspect relevant states and actual usage sizes, not a fixed screenshot count or every width × theme × state combination. Batch related edits and reuse a current application instance and valid evidence. Documentation-only changes and refactors with evidence of unchanged rendering need no new UI captures; state that basis.

When a before/after comparison is needed, preserve the actual starting implementation, including uncommitted work, and use comparable capture conditions. Never recreate a missing before image and present it as an original. Protect existing work regardless of whether extra evidence is needed.

Before handoff, review or push, check only new cumulative interactions, missing required checks and invalidated evidence; do not repeat completed verification at each stage. Report results and material gaps accurately. Do not claim full coverage or visual acceptance when required scenes or checks are missing.

These effort levels change only the additional design-review procedure. Existing [client test requirements](../../../packages/client/AGENTS.md), [GUI PR GIF requirements](../record-browser-gif/SKILL.md#every-gui-pull-request-includes-a-gif), and [designer/product approval](#design-review-escalation) still apply, including to local changes when their original triggers are met.

## Select the rule owners

For layout changes, read the alignment and spacing references. Read the icon reference when selecting, drawing or reviewing artwork, or when adding, changing or reviewing icon buttons, icon-only actions or informational icons, including reuse without artwork changes. Other tasks use the relevant sections below. Do not load all references by default. Existing responsive and official-artwork skills retain their scopes; numeric scales stay with their implementation owners.

| Decision needed before implementation | Section or reference |
|---|---|
| Shared axes, text starts, centering, tree indentation, complete icon boxes | [Alignment](references/alignment.md) |
| Semantic groups, inner/outer gaps, repeated rhythm, section separation | [Spacing and grouping](references/spacing.md) |
| Interface icon selection and artwork; icon buttons and icon-only actions, tooltips, informational hover content, accessible labels and focus | [Icons](references/icons.md) |
| Color, typography and existing treatments | [Visual foundation](#visual-foundation); [Web styling](../../../docs/web-styling.md) owns tokens/materials |
| Component geometry, nested contours and state fills | [Geometry decisions](#component-geometry); [radius standard](../../../docs/ui-radius.md) owns values and exceptions |
| Feedback lifetime, loading, overlays, scrolling and platform clearance | [Interaction and feedback](#interaction-and-feedback); [error handling](../dsh-error-handling/SKILL.md) owns failure guarantees |
| Responsive layout rules, mobile-specific interactions, and truncation/ellipsis rules for components like text and buttons | [Responsive UI](../dsh-responsive-ui/SKILL.md) |
| Official plugin artwork and feature previews | [Official artwork](../dsh-official-plugin-artwork/SKILL.md) |
| Copy, locale ownership and component semantics | [Prose standard](../dsh-prose-standard/SKILL.md), [locale ownership](../../notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md), [primitives catalog](../../../packages/client/ui-primitives/README.md#component-catalog) |
| Density, information hierarchy, combined control states and component choice | [Principle reference](../../../docs/ui-design-review-cases.md#density) sections 3–6 |

## Reuse before adding

Extend existing components, containers and interactions when the capability fits. Register right-sidebar content through a slot in the existing sidebar; do not create a separate sidebar. Follow [icon reuse](references/icons.md#reuse-existing-icons-first). Before restructuring, read [client instructions](../../../packages/client/AGENTS.md) and [client defensive patterns](../../../docs/defensive-patterns/client-components.md) for component/state ownership and layering.

## Visual foundation

- Reuse tokens, values and complete treatments from the target page or nearest established sibling before adding literals; Plugins is the usual full-page reference.
- Verify colors in light and dark themes; keep ink/background pairs readable, especially dimmed text.
- Feature CSS you add or change uses **font weight ≤500**; emphasize with size or ink. ui-theme markdown typography tokens are the exception.
- Use theme typography roles, then the page's scale, then a comparable page's size/spacing ratios. Do not invent a size for a single element. Peers share sizes; keep the scale small (13px is the established row/detail size).
- Apply [alignment](references/alignment.md) and the [same-foreground rule](references/icons.md#placement-and-use) to icon/text relationships, including value chevrons and search prompts.

## Component geometry

Choose component role and size variant, then its container relationship. Compare height, radius, curve, inset and material together; equal radii alone do not establish coherence, and wrapping/expansion alone does not justify larger radii. [Radius standards](../../../docs/ui-radius.md#radius-scale) own values and exceptions.

- **Inset:** coordinate inner/outer curves and inset. Radius subtraction is exact for concentric circular arcs; for superellipses, subtraction is only a nominal sizing rule, so inspect diagonal whitespace as well as side gaps.
- **Flush or adjoining:** the enclosure owns exposed corners; internal joins stay square. Hover fills and pseudo-elements follow that contour without clipping menus or focus.
- **Independent child card/group:** use its own role/size tier, not the dialog radius or subtraction of all parent padding.
- **Circles/capsules:** preserve shape, including avatar container and image, using the theme's round-curve exception; ordinary controls use the shared curve.

Keep fills, strokes and overlays geometrically stable across hover, pressed, selected, loading and disabled states. Reuse [card/elevation materials](../../../docs/ui-radius.md#settings-cards): shadows already include neutral hairlines; retain semantic state-colored borders without doubling neutral edges.

Compare related controls, including small selection controls, at actual size in affected themes/states and relevant long-label/narrow layouts. Static checks reject unsupported declarations; rendered comparison judges fit. Consult [geometry cases](../../../docs/ui-design-review-cases.md#geometry) when needed. Apply to scoped changes, not bulk restyling.

## Interaction and feedback

### Feedback surfaces

Follow [error handling](../dsh-error-handling/SKILL.md#localized-actionable-visible-reports). Choose feedback by message lifetime:

- Transient success/failure uses the app-wide Toast, with state and rendering in a host that survives the reporting panel/tab, such as a `shell.overlay` entry. A deletion may close its source panel; a Toast owned by that panel would disappear with it. Do not toast pending states.
- Failed operations retain visible data; failed deletion keeps the row.
- Surface-owned failures use in-place notices: query failure with Retry or field validation. Keep a compact notice beside populated content; only empty panels center a full error state.
- Use short plain-language errors, preferably one sentence, without internal jargon except necessary diagnostic codes. Chinese notices of at most two sentences omit the trailing 句号（。）. Reserve space or overlay notices so neighbors do not shift.

### Loading states

Lists use skeletons; other page-level loads center a bare spinner. Keep one loading treatment per page/component, including concurrent regions. Add loading text only when context requires it.

### Overlays and menus

Before merge, verify every menu, popover and tooltip closes on outside click (and Escape when focusable), fits the viewport with an edge margin, and escapes ancestor clipping, containing blocks and neighbor coverage, using a portal to body when needed. Flip only into a side that fits; never oscillate when neither fits.

Use shared scrollbar styles and a small inset; bars must stay inside containers without being clipped by rounded corners or edges.

### Platform window adaptation

New headers/pages account for macOS and Windows chrome. Menu, Modal and overlay primitives consume `--dsh-frame-top-clearance`; fix local macOS insets with scoped `[data-platform='darwin']` overrides and stylesheet assertions, not global-variable changes. Review the total clearance + page inset.

## Check the rules together

Inspect the composition, then affected internal/cross-group relationships, distant peers and expanded content. Match both endpoints of axes; compare complete icon boxes before optical adjustments. Preserve popup/focus visibility, field feedback, narrow-layout actions and drafts. Check affected theme materials/platform backdrops. Full-interface claims cover all regions; fixtures/crops establish only what they render.

## Maintain one owner per rule

Update the owning section or reference within this skill; do not expose its design specialties as separate skills. Keep examples in the [case reference](../../../docs/ui-design-review-cases.md); AGENTS and PR workflows link here instead of duplicating rules.

Rule changes state applicability, decisions, exceptions and observable verification; update a distinguishing case and remove superseded statements elsewhere. Declare migration versus future-edit scope without implying existing UI conforms. Automate only mechanically decidable checks. Local review tools consume repository rules and retain source/rule revisions rather than maintaining another standards copy.

## Design review escalation

- A PR with extensive UI changes, or any clearly user-perceivable change to UI or interaction, must get a designer or product review. When no approver holds that role, suggest requesting one from the design/product reviewers (roster as of 2026-09: yx zhang, yifffan, zhangziya, gaokaige; update this list here when membership changes).
