---
kind: upgrade-guide
description: "Code that constructs ComposerBarProps must now supply renderSlotChain for the built-in composer placeholder."
---

# Composer bar props require a placeholder renderer

English | [中文](guide.zh.md)

## Change

`ComposerBarProps` from `@deepseek-ai/dsh-client-ui-conversation/client` now requires `renderSlotChain` for `conversation.input.placeholder`. Code that constructs these props without that member fails type checking. Whole-bar replacements that use `ComposerBarProps` need a props type derived from their own registration.

## Migration

1. For fixtures that construct `ComposerBarProps`, provide `renderSlotChain: (_key, _owner, options) => options?.fallback` to render the built-in placeholder in tests without slot contributions.
2. For a replacement registered in `conversation.composer.bar`, start with `PropsRuntime<'conversation.composer.bar'>` from `@deepseek-ai/dsh-client-ui-slots`. Add `PropsRenderSlots` for the child keys in the replacement's own registration and keep the injected and locale props it uses. See [Slots](../../../subsystems/slots.md).
3. Run your TypeScript check to confirm the updated props and registration agree.
