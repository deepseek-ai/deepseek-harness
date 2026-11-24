---
kind: upgrade-guide
description: "Component Factories now wrap their output and caller-selected local components in DOM elements, changing which nodes match direct-child and empty selectors."
---

# DOM roots for Component Factories

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, the renderer added no element around a Component Factory or its local components. After upgrading, rendering a registered Factory adds a root such as `[data-slot-factory="Tree"]`, even if the Factory returns `null`. With no definition, `renderFactorySlot()` renders the caller's `fallback` unchanged, or `null` if omitted, without a Factory root.

A local root such as `[data-slot-factory-children="Tree:tail"]` appears only when the caller explicitly selects a component and the Factory mounts it. The value joins the registered Factory name and the declared local slot name with an ASCII colon (`:`), without encoding either name. The default local component has no local root, and calling `useFactorySlot()` without mounting the returned component adds none. Neither attribute identifies an implementation module or an individual instance.

## Migration

1. Update direct-child (`>`) selectors in your plugin's CSS and DOM queries. For example, `[data-slot-factory="sidebar.files.tree"] > ul` selects the [file tree](../../../../packages/client/ui-sidebar-files/README.md#tree-factory)'s top-level list. Check `parentElement` traversal too: both kinds of root use `display: contents` and have no layout box. Measure the list or its layout container, not the Factory root.
2. Where HTML requires phrasing content, set `inline: true` in the Factory's `registerFactory()` options or in the relevant local slot declaration, such as `slots: { tail: { scope: 'root', inline: true } }`. Each setting independently selects `span` instead of the default `div` for that root and its error placeholder. Where neither tag is valid, move the render position. The `renderFactorySlot()` and `useFactorySlot()` signatures are unchanged.
3. To check `:empty`, render a file tree with one entry and a caller-selected `accessory` that returns `null`. The selector `[data-slot-factory-children="sidebar.files.tree:accessory"]:empty` matches the local root; its parent is not `:empty`. Omit the selection and confirm that the tree still renders but the selector matches nothing in it.
