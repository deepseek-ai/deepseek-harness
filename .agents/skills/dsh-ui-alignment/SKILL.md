---
name: dsh-ui-alignment
description: Design or review DSH layout alignment, shared text columns, icon and label placement, tree indentation, and centering across groups. Apply before positioning elements and when checking rendered results.
---

# UI alignment

Use this decision guidance within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop). Apply it to the affected groups in their page or modal context; examples are not a coverage list.

Align elements that the reader compares as peers, including the space reserved for optional icons or actions.

### Layout structure first, visual calibration second

An icon's complete box includes intentional whitespace around its drawing and is a valid layout unit. Distinguish the interaction target, painted button surface, icon box and drawn contour: enlarging the target must not move the icon box, and internal whitespace must not be removed merely because painted pixels miss a guide. Compare shared slots, text columns and gaps first, then inspect balance at the intended size. Neither aligning every differently shaped contour from a screenshot nor accepting visibly unbalanced results solely because boxes agree is sufficient.

Trace misalignment to containers, slots and unintended overrides first. Once the structure is sound, distinguish an inconsistent library glyph from an optical adjustment needed by a particular composition. The icon owner handles the former; justify and scope the latter, then inspect comparable uses. Preserve the owning design’s hierarchy and indentation. A child icon may continue the parent text column when that is the intended tree relationship; DOM nesting alone does not establish it. When comparing a bare icon with a bordered control, do not treat extra hit padding as a common visible edge. Small contour differences caused by intentional whitespace are not automatically defects.

An inline SVG’s `vertical-align: middle` uses the baseline and font x-height; it does not establish centering with adjacent text. Identify the font, size, line height, and complete icon box before choosing a text metric as the reference, then check CJK, Latin, monospace text, and wrapping. Do not turn a multiline link into an unwrappable flex unit to center its icon; verify the adjustment across fonts.

### Choose both the object and the axis

Specify what is aligning to what. Distinguish the element's layout box, its visible glyph or text, its clickable area, and the container that defines its position. Equal padding does not guarantee equal text starts; equal SVG dimensions do not guarantee equal visible centers. An icon and label form a unit, repeated units form a column, and corresponding columns can continue across section boundaries.

| Alignment | Use it for | Judge the actual relationship | Common mistake |
|---|---|---|---|
| Left edge | Navigation labels, list titles, field labels, reading content | Same-role text starts on one deliberate axis, including across groups | Every component has its own plausible but different inset |
| Horizontal center | A standalone primary button or short empty-state stack | Center the icon-plus-label or full stack in the named container | Center the label alone and attach an icon outside it |
| Vertical center | A single-line icon/label row or peer toolbar controls | Visible centers balance; the whole clickable unit keeps a stable height | Equal CSS heights hide different SVG whitespace or line boxes |
| Baseline / first line | Mixed text sizes, multiline labels with leading icons | Text baselines agree; an icon belongs to the intended first line | Center an icon beside the entire multiline paragraph |
| Two edges | Title/action rows and left/right composer groups | Left group follows the content edge; right group follows the trailing edge | Distribute every icon across the available width |
| Repeated columns | Action clusters, timestamps, file rows | Corresponding slots share centers or edges across rows | Only the last icon aligns; preceding icons drift |

For left-to-right Chinese and English navigation, identify the leading icon center, text start and trailing controls by role. Continue an axis across groups only where the owning design establishes that relationship. Headings, account avatars and expandable search controls can use different geometry. DOM nesting alone neither requires nor forbids an indent.

### Sidebar design baseline

Use the current master sidebar design as the reference for layout, spacing, alignment and states. Verify the base revision and record it with the review evidence. Read the [sidebar](../../../packages/client/ui-sidebar/README.md), [workspace](../../../packages/client/ui-workspace/README.md) and [account](../../../packages/client/ui-settings-account/README.md) owners and their styles before proposing a correction. Keep their shared spacing variables, icon slots and painted insets; compare hover and selected backgrounds with the intended button edges separately from content axes.

Compare same-role rows and preserve their title starts when actions appear. Do not force the signed-in account row onto the navigation text axis, or the workspace header’s search/filter/add controls onto conversation action columns. Search expansion and collapsed-rail states have their own layout. A retained icon correction does not authorize changing these relationships. Inspect the assembled sidebar in the relevant states; an older case image or isolated row cannot override the baseline.

For other layouts, preserve established cross-panel relationships: plugin content shares its reading edge even when hover paint extends beyond it; conversation and right-sidebar header rows share their intended heights and horizontal baselines. Choose the relationship from the composition, not merely from similar CSS values.

Centering always has a reference rectangle. A centered button uses its own bounds; a welcome area uses the main pane; an empty state generally uses the content space remaining below the page heading and filters. A fixed top margin is not vertical centering. If a short window cannot contain that group, preserve scroll access and use a compact top-aligned layout instead of clipping it. Two-edge alignment also operates on groups: keep each group's internal gaps fixed as the space between groups grows.

Change element size when that is the coherent way to obtain alignment. Normalize peer button slots and icon containers before adding individual offsets. Then apply a small optical correction only when the drawn shape still requires it, and verify other uses. Keep click targets usable; shrinking them to force alignment or using transforms to conceal inconsistent parent layout is not an acceptable fix.


Check neighboring groups with [spacing](../dsh-ui-spacing/SKILL.md). Changing a gap must preserve the chosen reference axes.

See [worked examples](../../../docs/ui-design-review-cases.md#alignment) when the relationship is unclear.
