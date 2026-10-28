# UI alignment

Apply within the [UI development loop](../SKILL.md#required-review-loop). Align comparable peers, including slots for optional icons and actions.

## Layout structure first, visual calibration second

Distinguish click target, painted button, complete icon box and drawn contour. Intentional icon whitespace belongs to the layout box; do not remove it merely because painted pixels miss a guide. Enlarging a target must not move that box. Check containers, slots, columns, gaps and unintended overrides before optical corrections. Neither matching CSS boxes nor aligning every painted contour alone establishes balance.

A glyph inconsistent across uses belongs to its icon owner. A composition-specific optical correction needs a scoped justification and comparison with peers. Preserve intended hierarchy: a child icon may align with parent text, but DOM nesting alone does not determine indentation. When comparing a bare icon with a bordered control, extra hit padding is not a shared visible edge.

Inline SVG `vertical-align: middle` follows font baseline/x-height, not visible text center. Check font, size, line height and icon box across CJK, Latin, monospace and wrapping. Do not make multiline links unwrappable just to center an icon.

## Choose both the object and the axis

Name the aligned object and reference container. Equal padding need not align text starts; equal SVG dimensions need not align visible centers. For a close control beside footer actions, explicitly choose the control edge or complete icon-box edge; do not switch between them while measuring.

| Alignment | Use it for | Judge the actual relationship | Common mistake |
|---|---|---|---|
| Left edge | Navigation labels, list titles, field labels, reading content | Same-role text starts on one deliberate axis, including across groups | Every component has its own plausible but different inset |
| Horizontal center | A standalone primary button or short empty-state stack | Center the icon-plus-label or full stack in the named container | Center the label alone and attach an icon outside it |
| Vertical center | A single-line icon/label row or peer toolbar controls | Visible centers balance; the whole clickable unit keeps a stable height | Equal CSS heights hide different SVG whitespace or line boxes |
| Baseline / first line | Mixed text sizes, multiline labels with leading icons | Text baselines agree; an icon belongs to the intended first line | Center an icon beside the entire multiline paragraph |
| Two edges | Title/action rows and left/right composer groups | Left group follows the content edge; right group follows the trailing edge | Distribute every icon across the available width |
| Repeated columns | Action clusters, timestamps, file rows | Corresponding slots share centers or edges across rows | Only the last icon aligns; preceding icons drift |

For Chinese/English navigation, identify leading icon centers, text starts and trailing controls by role. Headings, avatars and expandable search may differ. Continue axes only where the composition establishes them, including shared plugin reading edges even when hover paint extends beyond them, and conversation/right-sidebar header heights and baselines.

For a trigger and its menu, or search field and result rows, compare the complete text inset: outer padding, borders, leading slot and gap. Different icon sizes can retain one text start. For adjacent statistics, check font family, size, weight and line height together before moving the icon.

Center a button within its own bounds, a welcome group within the main pane, and an empty state within the content remaining below headings/filters. A fixed top margin is not centering. When a short window cannot fit the group, preserve scroll access with a compact top-aligned layout instead of clipping.

Normalize peer control sizes and slots before any necessary small optical offsets; verify comparable uses. Preserve usable, non-overlapping hit targets and do not hide inconsistent parent layout with transforms. Transparent hit padding can exceed the painted icon slot; check neighboring target edges after tightening a cluster. Check [spacing](spacing.md) without moving the chosen axes; consult [cases](../../../../docs/ui-design-review-cases.md#alignment) for uncertain judgments.
