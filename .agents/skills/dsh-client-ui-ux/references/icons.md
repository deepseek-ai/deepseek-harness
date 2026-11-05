# UI icons

Apply within the [UI development loop](../SKILL.md#required-review-loop), in the affected page or modal context.

## Reuse existing icons first

Search the library and comparable UI for the intended meaning and supported variants. Reuse the shared component; do not copy its SVG into a feature or create a near-duplicate. Size, color and placement mismatches belong to the variant or consumer layout, not a new drawing.

Draw only when existing artwork cannot express the meaning or the user requests a distinct design. Before drawing, explain the closest alternatives and the unmet meaning or requested design difference. New glyphs require designer approval before landing; requested drafts can be prepared locally. Do not redraw a shared glyph to fix one consumer.

The [primitives icon contract](../../../../packages/client/ui-primitives/README.md#controls-and-icons) and icon source own available variants, stroke scaling and menu sizes; [official artwork](../../dsh-official-plugin-artwork/SKILL.md) owns package artwork.

## System style

- Use minimal, geometric, functional glyphs with familiar meanings. Match peers in contour, endings, joins, weight, whitespace and complexity; avoid decorative, playful or illustration-like detail. A supplied reference guides the requested meaning and distinctive form within this system.
- Use simple geometry and restrained rounding. Around 1px at a 16px design size is a starting point for softened corners, not a rule for every turn. Preserve useful sharp corners.
- Default to monochrome outlines inheriting `currentColor`, without gradients, shadows, textures or 3D effects. Preserve intentional fills, status dots, selected marks and knockouts. File, site, plugin and brand artwork retain their own palettes and roles.
- Balance structure and whitespace without requiring symmetry; avoid accidental tilt or a top-heavy silhouette. Preserve meaningful direction. Use gaps, overlap, nesting and broken obscured lines to clarify complex meanings; avoid accidental tangencies, dark knots and disappearing gaps at actual size. Add contour detail only when it improves recognition; do not force every subject into a closed outline.

## Optical size and clarity before implementation

Use the owning control's supported size and weight. [Shared menu sizes and stroke scaling](../../../../packages/client/ui-primitives/README.md#controls-and-icons) belong to primitives; [permission triggers](../../../../packages/client/ui-permission-presets/README.md) and [settings navigation](../../../../packages/client/ui-settings-general/README.md) belong to their feature packages. A reviewed proposal for a larger or heavier trigger is not a statement that every existing consumer already uses it. Compare at the owning control's size, weight, colors and label, using an outlined circle and rectangular control as references. Open silhouettes may need more extent than dense fills; supporting chevrons, handles and dots keep their roles. Do not normalize by ink area or fill every view box.

A shared view-box change affects every consumer at its own CSS size. Inspect both compact menus and larger icon-only controls; a clearer small chevron can become oversized in a floating button. Adjust a consumer’s supported icon size when needed while retaining its button base and hit target.

For softness, check CSS dimensions and ancestor transforms, view box and drawing bounds, stroke versus filled contour, device-pixel placement, then color/opacity. Non-16 view boxes are valid; compare identical artwork before attributing sharpness to inline SVG versus sprites.

Use the [implemented stroke behavior](../../../../packages/client/ui-primitives/README.md#controls-and-icons): source stroke widths scale with the SVG viewport, and filled outlines scale as geometry. Do not add non-scaling strokes or convert filled contours during an ordinary placement or reuse fix. A change to that rendering contract belongs to a separately scoped library change with consumer validation; retain intentional silhouettes and knockouts.

Check straight-stroke edges at actual DPR after all scaling: center and width jointly determine coverage. Integer source coordinates alone do not guarantee crisp edges. Round positioned overlays in device pixels only when layout places otherwise crisp artwork between pixels; preserve anchoring and viewport containment. Keep antialiasing on curves/diagonals; do not globally round paths or use `crispEdges` to hide placement errors. Partial coverage is legitimate for 1.3px strokes.

## Draw a new icon

Establish meaning, placement, actual sizes, peers and states; ask only when missing information changes the design. Produce editable SVG; shared line icons need Regular and Medium variants sharing construction; intentional fill-only variants may share geometry. Tune silhouette, gaps, center and weight at intended size using component/theme conventions, not consumer-specific stroke or scale overrides.

Deliver editable artwork and a rendered peer comparison, including its label or control when relevant. Explain the semantic choice and unresolved alternatives. Keep drafts local; when implementing, register reusable components and update their documentation. Distinguish review-ready proposals from approved glyphs.

## Normalize user-supplied artwork

Before changing supplied artwork, establish its meaning, recognizable features and intended use. Preserve the original and recognizable form. Show an existing equivalent as a reference when available, but do not substitute it for the drawing the user asked to normalize. Separate technical fixes (canvas, scale, stroke, color inheritance, placement) from silhouette or metaphor changes; identify any required simplification.

Apply the same system style and verification criteria as new artwork. Inspect SVG paths, transforms, fills, strokes and references. Reconstruct raster references without tracing rasterization or compression artifacts; identify interpreted details and ask about unrecoverable defining features. Deliver editable SVG and original/normalized/peer comparisons under identical conditions at intended size. Keep artwork changes separate from consumer layout fixes.

## Placement and use

Distinguish click target, visible button base, icon slot and painted glyph. Equal targets or SVG dimensions do not imply equal optical size; compare silhouette, stroke, whitespace and center beside the label. Fix containers and unintended CSS overrides first. Correct shared artwork only when the imbalance follows it across uses.

An icon and its associated text for one action, value or input prompt must share foreground color, effective opacity and state changes. This includes submenu value chevrons and search placeholders; inherit the shared role instead of assigning an independent icon token. Typed text and independent clear actions may differ; status, warning and brand roles retain semantic colors. Check computed color and ancestor opacity in both themes. Apply the rule to changed consumers; updating it does not certify untouched UI. Compare native file icons and folder outlines deliberately; do not normalize logos, status dots or decorative illustrations to toolbar icons.

Every right-sidebar tab needs a meaningful icon. [Alignment](alignment.md) owns positioning and [spacing](spacing.md) owns gaps.

## Icon controls and interaction

Use the shared Tooltip for unclear icon-only actions and HoverCard for informational content requiring hover or selection; prefer these primitives over ad-hoc `title` attributes. Preserve accessible labels and focus. [Responsive UI](../../dsh-responsive-ui/SKILL.md) owns mobile tooltips and label collapse.

## Verification and handoff

For ordinary icon reuse or placement changes, inspect the affected control at its actual size and relevant states; no fixed size/DPR matrix or separate raster report is required. For new or changed artwork, strokes or rendering, compare affected sizes and weights with peers; check DPR 1 and 2 when stroke scaling or pixel placement can change, and both themes when color or optical weight is affected. Keep before/after captures when needed for the change or requested deliverable. Judge recognition, clipping, center, gaps and neighboring text at actual size; enlarged views diagnose pixels only.

After a set-wide change, trace affected families, consumers and weights, including unchanged artwork whose rendering can change. Use unchanged peers for comparison. An explicitly requested full-set review inventories and compares every glyph under matching conditions. Consolidate duplicate artwork only when necessary for the current fix; record unrelated duplicates separately instead of expanding the task. Consult [cases](../../../../docs/ui-design-review-cases.md#icon-optics) for uncertain judgments.
