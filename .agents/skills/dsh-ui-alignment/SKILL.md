---
name: dsh-ui-alignment
description: Design or review DSH shared text columns, icon/label placement, tree indentation and centering. Apply before positioning elements and when checking rendered results.
---

# UI alignment

Apply within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop). Align comparable peers, including slots for optional icons and actions.

### Layout structure first, visual calibration second

Distinguish click target, painted button, complete icon box and drawn contour. Intentional icon whitespace belongs to the layout box; enlarging a target must not move that box. Check containers, slots, columns, gaps and unintended overrides before optical corrections. Neither matching CSS boxes nor aligning every painted contour alone establishes balance.

A glyph inconsistent across uses belongs to its icon owner. A composition-specific optical correction needs a scoped justification and comparison with peers. Preserve intended hierarchy: a child icon may align with parent text, but DOM nesting alone does not determine indentation. Extra hit padding is not a visible edge.

Inline SVG `vertical-align: middle` follows font baseline/x-height, not visible text center. Check font, size, line height and icon box across CJK, Latin, monospace and wrapping. Do not make multiline links unwrappable just to center an icon.

### Choose both the object and the axis

Name the aligned object and reference container. Equal padding need not align text starts; equal SVG dimensions need not align visible centers.

| Alignment | Required relationship |
|---|---|
| Left edge | Same-role labels and reading content share a deliberate text axis across relevant groups. |
| Horizontal center | Center the whole icon/label unit or empty-state stack in its named container. |
| Vertical center | Balance single-line peers visually while keeping stable clickable heights. |
| Baseline / first line | Align mixed-size text baselines; attach leading icons to the intended first line, not the whole paragraph. |
| Two edges | Anchor left/right groups to their respective edges; preserve internal gaps instead of distributing every icon. |
| Repeated columns | Align all corresponding slots, not just the last action. |

For Chinese/English navigation, identify leading icon centers, text starts and trailing controls by role. Headings, avatars and expandable search may differ. Continue axes only where the composition establishes them, including shared plugin reading edges even when hover paint extends beyond them, and conversation/right-sidebar header heights and baselines.

Center within the button, main pane or content remaining below headings/filters, as appropriate. A fixed top margin is not centering. When a short window cannot fit the group, preserve scroll access with a compact top-aligned layout instead of clipping.

Normalize peer control sizes and slots before any necessary small optical offsets; verify comparable uses. Preserve usable hit targets and do not hide inconsistent parent layout with transforms. Check [spacing](../dsh-ui-spacing/SKILL.md) without moving the chosen axes; consult [cases](../../../docs/ui-design-review-cases.md#alignment) for uncertain judgments.
