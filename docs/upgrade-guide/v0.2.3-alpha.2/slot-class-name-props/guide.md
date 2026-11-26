---
kind: upgrade-guide
description: "The contextMenu.button Factory and the conversation.hero.brand.mark slot no longer accept a className from the caller; the menu button takes a size instead."
---

# Class names removed from the menu button and the hero brand mark

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, a caller could pass its own CSS class through `renderFactorySlot('contextMenu.button', { className })`, and the [Conversation](../../../../packages/client/ui-conversation/README.md) blank home passed a `className` to the occupant of `conversation.hero.brand.mark`. A class from one package does not reach another package's DOM once [package style isolation](../../../../packages/client/ui-renderer/README.md#package-style-isolation) applies, so both props are removed. TypeScript rejects `className` in either call.

The [menu button](../../../../packages/client/ui-context-menu/README.md) now styles itself and takes `size?: 'sm' | 'row'`. `size: 'sm'` still adds the label tooltip, and its button is now a 28px square around a 15px secondary glyph instead of the 36px-wide compact primitive button. `size: 'row'` is new: a 24px target with -4px margins around a 14px tertiary glyph, without a tooltip. Omitting `size` still renders an unstyled native button.

A `conversation.hero.brand.mark` occupant now receives only `{ size }`. The hero applies its color, overflow and hover sway only to its own fallback whale.

## Migration

1. Remove `className` from each `renderFactorySlot('contextMenu.button', …)` call. For a button in a list row, pass `size: 'row'`; for a toolbar control, pass `size: 'sm'`. Delete the caller rules that styled the button.
2. A plugin whose container rules style the unsized button keeps working without isolation; with isolation enabled, those rules no longer match the button inside the Factory.
3. In a component registered for `conversation.hero.brand.mark`, stop reading `props.className` and give the mark its own class from your package for its color and motion.
4. Run `pnpm run typecheck`: no `className` errors remain. In the Web UI, the button keeps its expected size with the caller's isolation set to `style`.
