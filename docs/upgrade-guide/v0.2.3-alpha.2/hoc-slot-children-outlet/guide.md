---
kind: upgrade-guide
description: "A Web Client hoc layer's forwarded children now sit inside a DOM element, which changes direct-child and sibling selectors."
---

# DOM selectors for hoc slot children

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, the renderer inserted no DOM element where a `hoc` layer rendered `children`. After upgrading, it inserts one `[data-slot-children="key"]` element there, around the inner content. The value names the slot that supplied those `children` to the layer, even when another slot renders them. The element uses `display: contents`: it has no layout box but still participates in DOM queries and CSS selectors. The outer `[data-slot="key"]` stays in place. With no applicable layer, it still renders the owner's content without a children outlet. See [hoc layers](../../../subsystems/slots.md#hoc-layers).

## Migration

1. Check your plugin's stylesheets, DOM queries, and tests for direct-child (`>`) or sibling (`+`, `~`) selectors and traversal such as `firstElementChild` across a hoc layer. Slot registrations and React components that only render or replace `children` need no changes.
2. Suppose an `outer.frame` layer forwards the owner's button and an extra button in one fragment through `inner.frame`. If the `inner.frame` layer returns `children` unchanged, both buttons match `[data-slot-children] > button`, and `closest('[data-slot]')` on either button finds `inner.frame`.
3. Query within the `[data-slot="outer.frame"]` element for the intended instance. Use `[data-slot-children="outer.frame"] > button` for the owner's button and `[data-slot-children="inner.frame"] > button` for the extra button. To match the extra button as a sibling, use `[data-slot-children="outer.frame"] + button`: it follows the outlet, not the owner's button.
4. Render two `outer.frame` instances and confirm each name-based selector matches only the intended button within the chosen instance. With no applicable `outer.frame` layer, the owner's button is a direct child of `[data-slot="outer.frame"]`; if a layer replaces `children`, expect the original button to be absent.
