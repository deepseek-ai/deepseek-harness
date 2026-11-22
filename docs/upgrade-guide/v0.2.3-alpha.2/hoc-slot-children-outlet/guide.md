---
kind: upgrade-guide
description: "A Web Client hoc layer's forwarded children now sit inside a DOM element, which changes direct-child and sibling selectors."
---

# DOM selectors for hoc slot children

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, the renderer inserted no DOM element where a `hoc` layer rendered `children`. After upgrading, it inserts one `[data-slot-children="key"]` element there, around the inner content. The element uses `display: contents`: it has no layout box but still participates in DOM queries and CSS selectors. The outer `[data-slot="key"]` stays in place. With no applicable layer, it still renders the owner's content without a children outlet. See [hoc layers](../../../subsystems/slots.md#hoc-layers).

## Migration

1. Check your plugin's stylesheets, DOM queries, and tests for direct-child (`>`) or sibling (`+`, `~`) selectors and traversal such as `firstElementChild` across a hoc layer. Slot registrations and React components that only render or replace `children` need no changes.
2. To find an element your plugin owns, select its class or attribute within the outer `[data-slot="key"]` instead of following a fixed number of children. To match a sibling of `children`, select the outlet by slot name. For example, if your `sidebar.session.action` layer puts `.extra` immediately after `{children}`, `[data-slot-children="sidebar.session.action"] + .extra` selects it. Its sibling is the outlet, not the New Session button inside it.
3. Inspect the slot with no applicable layer and then with two forwarding layers. Confirm that the owner's content appears without a children outlet in the first case and inside nested outlets in the second. If a layer replaces `children`, check that your code handles the original content being absent.
