---
name: dsh-ui-icons
description: Select, draw, normalize or review DSH action, navigation, file and status icons. Covers system style, optical size, clarity and text relationships; official plugin artwork has its own skill.
---

# UI icons

Apply within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop), in the affected page or modal context.

## Reuse existing icons first

Search the library and comparable UI for the intended meaning and supported variants. Reuse the shared component; do not copy its SVG into a feature or create a near-duplicate. Size, color and placement mismatches belong to the variant or consumer layout, not a new drawing.

Draw only when existing artwork cannot express the meaning or the user requests a distinct design. Before drawing, explain the closest alternatives and the unmet meaning or requested design difference. New glyphs require designer approval before landing; requested drafts can be prepared locally. Do not redraw a shared glyph to fix one consumer.

The [primitives catalog](../../../packages/client/ui-primitives/README.md#component-catalog) and icon source own available variants and stroke values; [official artwork](../dsh-official-plugin-artwork/SKILL.md) owns package artwork.

## System style

- Use minimal, geometric, functional glyphs with familiar meanings. Match peers in contour, endings, joins, weight, whitespace and complexity; avoid decorative, playful or illustration-like detail. A supplied reference guides the requested meaning and distinctive form within this system.
- Use simple geometry and restrained rounding. Around 1px at a 16px design size is a starting point for softened corners, not a rule for every turn. Preserve useful sharp corners.
- Default to monochrome outlines inheriting `currentColor`, without gradients, shadows, textures or 3D effects. Preserve intentional fills, status dots, selected marks and knockouts. File, site, plugin and brand artwork retain their own palettes and roles.
- Balance structure and whitespace without requiring symmetry; avoid accidental tilt or a top-heavy silhouette. Preserve meaningful direction. Use gaps, overlap, nesting and broken obscured lines to clarify complex meanings; avoid accidental tangencies, dark knots and disappearing gaps at actual size. Add contour detail only when it improves recognition; do not force every subject into a closed outline.

## Draw a new icon

Establish meaning, placement, actual sizes, peers and states; ask only when missing information changes the design. Produce editable SVG; shared line icons need Regular and Medium variants sharing construction; intentional fill-only variants may share geometry. Tune silhouette, gaps, center and weight at intended size using component/theme conventions, not consumer-specific stroke or scale overrides.

Deliver editable artwork and a rendered peer comparison, including its label or control when relevant. Explain the semantic choice and unresolved alternatives. Keep drafts local; when implementing, register reusable components and update their documentation. Distinguish review-ready proposals from approved glyphs.

## Normalize user-supplied artwork

Before changing supplied artwork, establish its meaning, recognizable features and intended use. Preserve the original and recognizable form. Show an existing equivalent as a reference when available, but do not substitute it for the drawing the user asked to normalize. Separate technical fixes (canvas, scale, stroke, color inheritance, placement) from silhouette or metaphor changes; identify any required simplification.

Apply the same system style and verification criteria as new artwork. Inspect SVG paths, transforms, fills, strokes and references. Reconstruct raster references without tracing rasterization or compression artifacts; identify interpreted details and ask about unrecoverable defining features. Deliver editable SVG and original/normalized/peer comparisons under identical conditions at intended size. Keep artwork changes separate from consumer layout fixes.

## Placement and use

Distinguish click target, visible button base, icon slot and painted glyph. Equal targets or SVG dimensions do not imply equal optical size; compare silhouette, stroke, whitespace and center beside the label. Fix containers and unintended CSS overrides first. Correct shared artwork only when the imbalance follows it across uses.

An icon and label for one action normally share foreground and state changes. Search icons and placeholders form one prompt; typed text and independent clear actions may differ. Verify opacity, stroke and background in both themes. Status, warning and brand roles may use different colors. Compare native file icons and folder outlines deliberately; do not normalize logos, status dots or decorative illustrations to toolbar icons.

Use the shared Tooltip for unclear icon-only actions and HoverCard for informational content requiring hover or selection. [Responsive UI](../dsh-responsive-ui/SKILL.md) owns mobile tooltips and label collapse. Every right-sidebar tab needs a meaningful icon. Preserve accessible labels and focus; [alignment](../dsh-ui-alignment/SKILL.md) owns positioning and [spacing](../dsh-ui-spacing/SKILL.md) owns gaps.

## Optical size and clarity before implementation

Ordinary menus use 14px Regular icons with 1px strokes; compact menus retain 12px. Permission triggers and settings-navigation peers use 16px slots; permission-menu rows retain 14px. Compare at the owning control's size, weight, colors and label, using an outlined circle and rectangular control as references. Open silhouettes may need more extent than dense fills; supporting chevrons, handles and dots keep their roles. Do not normalize by ink area or fill every view box.

For softness, check CSS dimensions and ancestor transforms, view box and drawing bounds, stroke versus filled contour, device-pixel placement, then color/opacity. Non-16 view boxes are valid; compare identical artwork before attributing sharpness to inline SVG versus sprites.

Regular strokes stay **1 CSS px**, Medium **1.3 CSS px** across sizes. Use non-scaling strokes, including inline composites. Filled outlines ignore stroke width: convert line contours to real strokes when consistent weight requires it; retain intentional silhouettes and knockouts.

Check straight-stroke edges at actual DPR after all scaling: center and width jointly determine coverage. Integer source coordinates alone do not guarantee crisp edges. Round positioned overlays in device pixels only when layout places otherwise crisp artwork between pixels; preserve anchoring and viewport containment. Keep antialiasing on curves/diagonals; do not globally round paths or use `crispEdges` to hide placement errors. Partial coverage is legitimate for 1.3px strokes.

## Verification and handoff

For ordinary icon reuse or placement changes, inspect the affected control at its actual size and relevant states; no fixed size/DPR matrix or separate raster report is required. For new or changed artwork, strokes or rendering, compare affected sizes and weights with peers; check DPR 1 and 2 when stroke scaling or pixel placement can change, and both themes when color or optical weight is affected. Keep before/after captures when needed for the change or requested deliverable. Judge recognition, clipping, center, gaps and neighboring text at actual size; enlarged views diagnose pixels only.

After a set-wide change, trace affected families, consumers and weights, including unchanged artwork whose rendering can change. Use unchanged peers for comparison. An explicitly requested full-set review inventories and compares every glyph under matching conditions. Consolidate duplicate artwork only when necessary for the current fix; record unrelated duplicates separately instead of expanding the task. Consult [cases](../../../docs/ui-design-review-cases.md#icon-optics) for uncertain judgments.