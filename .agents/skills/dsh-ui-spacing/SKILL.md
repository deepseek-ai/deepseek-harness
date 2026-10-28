---
name: dsh-ui-spacing
description: Design or review DSH semantic grouping, internal/external spacing and repeated rhythm, including wrapped or expanded content.
---

# UI spacing and grouping

Apply within the [UI development loop](../dsh-client-ui-ux/SKILL.md#required-review-loop). Distance should explain which text, input and action belong together.

### Identify the group before choosing the gap

Group elements by one object, action or repeated unit, not DOM siblings, background or React component. State that relationship before positioning. Check each nesting level independently; larger outer gaps do not require larger inner gaps.

Without an explicit divider, comparable neighboring groups need visibly greater separation between groups than within them. Equality is only a lower bound against reversal. Repeated compositions share gaps, padding and alignment; label length does not justify unrelated spacing.

When wrapping, metadata, subgroups or independent actions increase complexity, increase enclosing separation enough to retain grouping. Do not derive gaps from card area or multiply every margin. Dividers and distinct surfaces may reinforce separation, but headings must remain closer to their own content than to preceding groups.

Judge actual whitespace at normal size, including padding, line-height, glyph whitespace and borders. CSS margin ratios alone do not establish grouping; explanatory labels need one unambiguous owner.

Reuse page spacing and [style tokens](../../../docs/web-styling.md), preserve [alignment](../dsh-ui-alignment/SKILL.md) axes, and consult [cases](../../../docs/ui-design-review-cases.md#grouping) for uncertain judgments. This skill defines no numeric scale.
