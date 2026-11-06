---
kind: upgrade-guide
description: "Model-menu extensions must distinguish composer locking from a model selection being saved."
---

# Model-menu save state is separate from locking

English | [中文](guide.zh.md)

## Change

Extensions contributing to `conversation.input.model.options` receive a separate `pending` owner prop. Previously, `locked` also became true while a model or reasoning selection was being saved. `locked` now represents only the composer's unavailable state; `pending` represents the save in flight. An extension that guards actions only with `locked` can therefore accept another action during a save.

## Migration

1. Derive contribution props from `PropsRuntime<'conversation.input.model.options'>` and read both `locked` and `pending`. Update hand-built test owners to supply `pending`.
2. Reject state-changing or page-opening actions while `locked || pending`. Use native `disabled` for `locked`; represent temporary saving with `aria-disabled` and `aria-busy` while retaining the control's focus and appearance.
3. Verify that changing reasoning effort does not dim or move the extension's row, and that activating it during a held save issues no action. Verify that a genuine composer lock still disables the control.

See the [model-menu extension reference](../../../../packages/client/ui-model-selection/README.md) for the current owner props.
