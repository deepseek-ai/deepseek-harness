---
name: dsh-ui-icons
description: Reuse existing DSH interface icons first; draw missing glyphs, normalize user-supplied artwork, or review system style, optical size, clarity, and text relationships. Use for action, navigation, file and status icons; official plugin artwork has its own skill.
---

# UI icons

Use this decision guidance within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop). Apply it to the affected groups in their page or modal context; examples are not a coverage list.

## Reuse existing icons first

Before drawing or adding an icon, search the existing library and comparable UI for the intended meaning, component, size and weight variants. If an existing glyph expresses the action or state clearly, use its shared component. A request to add an icon to a feature does not by itself call for a new drawing. Do not copy its SVG into a feature-local implementation or create a near-duplicate merely to make that feature look different.

Draw a new glyph only when existing artwork cannot express the required meaning or the user explicitly requests a distinct design. Identify the closest existing alternatives and explain the unmet meaning or requested design difference before drawing. A size, color or placement mismatch alone is a reason to inspect the supported variant and consumer layout, not to invent another glyph. Follow the authoring workflows below for requested drawing or adaptation. A new glyph requires designer approval before landing; that requirement does not prevent preparing a requested draft. Do not silently redraw an existing glyph to fix a single consumer.

The [primitives catalog](../../../packages/client/ui-primitives/README.md#component-catalog) and icon source own the available variants and stroke values. [Official plugin artwork](../dsh-official-plugin-artwork/SKILL.md) owns package artwork, not action icons.

## System style

Design interface glyphs as a coherent tool-oriented set: minimal, geometric, functional, balanced, precise and technical. Prefer familiar action, navigation and workflow meanings that read quickly in professional software. Avoid cute, playful, hand-drawn or decorative treatments and illustration-like detail. Match neighboring library glyphs in contour, line endings, joins, optical weight, whitespace, proportions and complexity; a supplied reference guides the requested meaning and distinctive form within this system.

Use simple lines, circles, rectangles and summarized curves, with consistent line weight within each variant. Follow the fixed Regular and Medium strokes defined below; the system has both weights. Use restrained corner rounding that matches the closest peers. Around 1px at a 16px design size is a starting point for a small softened corner, not a radius to impose on every turn, circle or existing glyph. Preserve useful sharp corners and avoid an overly rounded appearance.

Default to monochrome outline artwork inheriting `currentColor`, without gradients, shadows, textures or 3D effects. Retain purposeful filled silhouettes, status dots, selected-state marks and knockout shapes already supported by the library. File, site, plugin and brand artwork follow their own roles and palette rules. Do not remove meaningful fill or color merely to make these categories resemble line icons.

Balance the visible weight horizontally and vertically through structure, whitespace and line distribution; geometric symmetry is not required. Avoid accidental tilt, a top-heavy silhouette or decorative motion. Keep direction when it carries meaning, such as an arrow. Simplify redundant detail without losing recognition, and do not force every subject into a single closed geometric outline.

For complex meanings, use relationships between a few elements: open or broken contours, controlled gaps, crossings, overlap, nesting and foreground/background order. Break an obscured line where needed to clarify which element is in front. These relationships must remain legible at the intended small size, without accidental tangencies, dark knots or gaps that disappear after rasterization. Add contour detail only when it improves recognition.

## Draw a new icon

Enter this workflow only after applying the reuse rule above. Establish the intended meaning, placement, actual sizes, neighboring icons and required states from the request and available UI context. Ask only when missing information would change the meaning or design. Use the closest library artwork as references for the new design.

Produce editable SVG geometry with the system style above. Develop the silhouette at the intended size, then tune internal gaps, optical center and weight. Provide Regular and Medium variants for shared line icons, preserving the same construction; intentional fill-only variants can share geometry. Follow the owning component and theme conventions rather than introducing consumer-specific stroke or scale overrides.

Use the verification section below. Deliver the editable artwork and a rendered comparison beside the chosen library peers, including the icon with its label or control when relevant. Explain the semantic choice and any unresolved alternative. Keep concept drafts local; register reusable components and update their owning documentation when implementation is in scope. Distinguish a proposal ready for review from an approved glyph ready to land.

## Normalize user-supplied artwork

Inspect the supplied SVG or image and establish its meaning, recognizable features and intended use before changing it. Check whether an existing library glyph already serves the product need. When the user specifically asks to normalize their own drawing, preserve that task and show the existing equivalent as a reference rather than silently substituting it. Preserve the original for comparison. Separate technical corrections such as canvas whitespace, scale, stroke, color inheritance and placement from changes to silhouette, detail or visual metaphor. Preserve the recognizable form unless the requested normalization requires simplification; identify any such design change in the result.

For SVG, inspect its paths, transforms, fills, strokes and internal references. Resolve unwanted scaling and filled line contours using the clarity rules below. A raster reference may need reconstructed vector geometry; do not trace antialiasing or compression artifacts into paths, and identify details that were interpreted. If a defining detail cannot be recovered, ask about that detail rather than presenting an invented feature as part of the original.

Apply the same style and verification criteria as new artwork. Deliver the original and normalized versions under identical rendering conditions, alongside established peers and at the intended use size. Include editable SVG and briefly distinguish technical fixes from design changes. Keep source artwork changes separate from corrections to an individual consumer's layout.

## Placement and use

Review the layout box, the painted glyph, and its relationship to neighbouring text as separate properties.

Judge four layers separately: clickable target, visible button base, icon slot, and painted glyph. Peer targets and bases can be equal while different glyphs need slightly different drawing bounds. Neither equal SVG width nor equal ink area establishes equal perceived size. Compare stroke weight, internal whitespace, silhouette, and center at the size actually used, with the adjacent text present.

First fix container layout and unintended CSS overrides. Correct a library glyph only if its imbalance follows it across uses; a single consumer's wrong size belongs to that consumer. A native file icon and a monochrome folder outline require a deliberate optical relationship even when their nominal boxes agree. Status dots, logos, and decorative illustrations are different roles and must not be normalized to toolbar icons.

An icon and label communicating one action normally share a foreground role and state changes. Search icons and placeholders form one prompt; typed text and an independent clear action can differ. Check actual opacity, stroke and background in both themes. Status, warning and brand roles can justify a different color.

An icon-only action with unclear meaning gets the shared Tooltip; informational content that must be hovered or selected uses HoverCard. The [responsive skill](../dsh-responsive-ui/SKILL.md) owns mobile tooltips and when labels may collapse. Every right-sidebar tab declares a meaningful icon.

[Alignment](../dsh-ui-alignment/SKILL.md) owns icon-plus-label positioning; [spacing](../dsh-ui-spacing/SKILL.md) owns the gap. Preserve accessible labels and focus when changing presentation.

See [worked examples](../../../docs/ui-design-review-cases.md#icon-optics) when the relationship is unclear.

## Optical size and clarity before implementation

Use 14px Regular line icons with fixed 1px strokes in ordinary menus; compact menus retain their 12px treatment. Permission-selector triggers and settings-navigation peers use 16px slots; permission-menu rows retain the ordinary 14px treatment. Choose size for the owning control and compare candidates together at that size, weight, foreground and background, including their labels. Use a representative outlined circle and rectangular control as references. Open silhouettes can need more extent than dense filled shapes; chevrons, drag handles and status dots retain their supporting roles. Never normalize all glyphs by bounding-box area or force every path to fill its view box.

When an imbalance repeats across consumers, adjust the owning artwork once. Inspect every library glyph and both weights after a set-wide change, including unchanged glyphs, inline composites, and feature-local duplicates. Consolidate duplicate semantic artwork where an existing shared glyph serves the same role. Keep file, site, plugin and brand artwork in separate comparison groups with their own intended sizes. Preserve an inventory so an omitted family cannot be mistaken for a completed review.

Diagnose softness in this order: rendered CSS dimensions and ancestor transforms; source view box and drawing bounds; stroke versus filled contour; final placement on the device pixel grid; then color and opacity. A non-16 view box is not itself defective. Neither inline SVG nor a sprite is inherently sharper: compare the same artwork through both paths before changing the rendering architecture.

Regular strokes remain 1 CSS pixel and Medium strokes 1.3 CSS pixels when the icon is resized. Use non-scaling strokes for line artwork, including inline composites. A filled outline ignores stroke width; if it represents an ordinary line icon, convert that contour to a real stroke when consistent weight across sizes is required. Preserve intentional filled silhouettes and knockout marks rather than applying the rule indiscriminately.

For a horizontal or vertical stroke, inspect its painted edges at the actual device pixel ratio (DPR), after all view-box and CSS scaling. Integer source coordinates alone do not establish crispness; center position and stroke width jointly determine edge coverage. At DPR 2 a 1px stroke can occupy two solid device pixels; a fractional offset can add grey edge pixels. Round positioned overlays in device pixels when their layout otherwise places crisp artwork between pixels. Check that this does not change anchoring or viewport containment. Keep antialiasing on curves and diagonals; do not globally round path points or use `crispEdges` to conceal a placement error. A 1.3px stroke legitimately has partial edge coverage.

## Verification and handoff

Verify light and dark themes at DPR 1 and 2, at 14px and 16px and any larger size the changed consumer uses. Keep a working-tree baseline and compare final raster output at actual size; enlarged pixel views only diagnose edge coverage. Check semantic recognition, consistency with peers, clipping, center, internal gaps, fixed stroke weight and neighboring text. For a full-set review, deliver every final glyph side by side, label changed and unchanged entries, and make the before/after comparison use identical rendering conditions.
