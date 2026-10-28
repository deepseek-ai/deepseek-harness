---
name: dsh-ui-spacing
description: Design or review DSH semantic grouping, internal/external spacing and repeated rhythm, including wrapped or expanded content.
---

# UI spacing and grouping

Apply within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop). Distance should explain which text, input and action belong together.

### Identify the group before choosing the gap

Group elements by one object, action or repeated unit, not DOM siblings, background or React component. State that relationship before positioning. Check each nesting level independently; larger outer gaps do not require larger inner gaps.

For example, a title and description introduce one section; three conversation actions form one operation group; member cards form a section separate from tasks. In a model form, checkbox and label form an option, options form a field, fields form a model, and models form a list. Check each relationship rather than applying one gap everywhere.

Without an explicit divider, comparable neighboring groups need visibly greater separation between groups than within them. Equality is only a lower bound against reversal. Repeated compositions share gaps, padding and alignment; label length does not justify unrelated spacing.

When wrapping, metadata, subgroups or independent actions increase complexity, increase enclosing separation enough to retain grouping. Do not derive gaps from card area or multiply every margin. Dividers and distinct surfaces may reinforce separation, but headings must remain closer to their own content than to preceding groups.

Judge actual whitespace at normal size, including padding, line-height, glyph whitespace and borders. CSS margin ratios alone do not establish grouping; explanatory labels need one unambiguous owner. For example, declared 16px/8px margins can still leave a heading closer to the preceding content once line-height and container padding are included; compare the rendered gaps rather than adopting that pair as a rule.

Reuse page spacing and [style tokens](../../../docs/web-styling.md), preserve [alignment](../dsh-ui-alignment/SKILL.md) axes, and consult [cases](../../../docs/ui-design-review-cases.md#grouping) for uncertain judgments. This skill defines no numeric scale.
