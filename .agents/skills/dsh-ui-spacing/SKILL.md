---
name: dsh-ui-spacing
description: Design or review DSH semantic grouping, internal and external spacing, repeated rhythm, and section separation. Apply before choosing gaps and when content wraps or expands.
---

# UI spacing and grouping

Use this decision guidance within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop). Apply it to the affected groups in their page or modal context; examples are not a coverage list.

Distance should explain which text, input, and action belong together before the reader needs a border.

### Identify the group before choosing the gap

Elements belong together because they describe one object, complete one action, or form one repeated unit. DOM siblings, equal backgrounds, or one React component do not establish that relationship. Write the grouping in ordinary language first: “title and description introduce this section”; “these three actions operate on this conversation”; “these cards form the members section, which is separate from the tasks section.” Then position the groups.

A group can contain smaller groups. In a model form, a checkbox and its label form an option; several options form an input-type field; that field joins other fields in one model; multiple models form the model list. Check spacing at each level. A very wide gap inside a higher-level layout does not require every lower-level gap to become larger.

For comparable neighboring groups without an explicit divider, the visible separation between groups must be greater than the gap joining elements inside each group. Equality is a lower bound against reversal, not the target when space is carrying the hierarchy. Repeated groups with the same composition share the same internal gap pattern, padding, and alignment. Different label lengths do not justify unrelated spacing rules.

As a group gains subgroups, wrapping, secondary metadata, or independent operations, its internal structure demands more separation from the next group. Increase the enclosing section gap enough to preserve that distinction. Do not compute space from card area or multiply every margin: a compact icon-and-label pair and a section of multi-line cards need different levels of spacing. A divider or distinct surface can reinforce the boundary, but it must not leave a heading visually attached to the preceding group.

Judge visible whitespace as well as CSS values. Button padding, line-height, glyph whitespace, borders, and margins all contribute. A declared 16px/8px margin pair can still produce an unclear heading relationship. At normal display size, the heading should appear closer to the content it introduces than to the previous section; an explanatory label should have one unambiguous owner.

Use existing page spacing and [style tokens](../../../docs/web-styling.md); this skill does not create a numeric scale. Check shared axes with [alignment](../dsh-ui-alignment/SKILL.md).

See [worked examples](../../../docs/ui-design-review-cases.md#grouping) when the relationship is unclear.
