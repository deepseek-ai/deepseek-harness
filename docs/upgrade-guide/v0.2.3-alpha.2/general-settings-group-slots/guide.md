---
kind: upgrade-guide
description: "Third-party replacements of built-in General Settings rows must target the row’s group item slot instead of settings.general.item."
---

# Built-in General Settings rows use group item slots

English | [中文](guide.zh.md)

## Change

When upgrading from v0.2.3-alpha.2, several built-in rows move from `settings.general.item` into group-owned item slots. A third-party registration that used the old slot and the built-in row’s ID to replace its presentation no longer shadows that row; it contributes a separate row to the default Preferences group instead.

Additive `settings.general.item` contributions remain supported. Language, appearance, and font preferences stay in that slot. Setting keys and persisted preference values do not change.

## Migration

1. In your client plugin’s `ctx.slots.inject` and `ctx.slots.register` calls, change the target slot for each moved built-in row. Keep the row ID and your intentional shadowing `priority`:

| Row ID | Target item slot |
|---|---|
| `permission`, `action-cards`, `transcript-view`, `developer-tools`, `performance-usage` | `settings.general.group.display.item` |
| `composer-enter`, `shortcuts`, `link-opening` | `settings.general.group.interaction.item` |
| `session-log-deepseek` | `settings.general.group.data.item` |
| `current-version`, `desktop-update-channel` | `settings.general.group.updates.item` |

2. Update your component’s `PropsRuntime` type to the chosen item slot. For example, a `developer-tools` replacement uses `PropsRuntime<'settings.general.group.display.item'>`. Select the group through the slot name; do not add a `groupId` property.
3. Reload the plugin and open General Settings. Confirm that your replacement appears once in the intended group and that the built-in presentation is absent. Disable the replacement and confirm that the built-in row returns when its feature is available.

For additive rows or custom groups, follow the [General Settings registration examples](../../../../packages/client/ui-settings-general/README.md#the-general-section). Custom groups declaration-merge their exact child item key into `SlotMap`, register `settings.general.group` entries with `id`, localized `label`, and `order`, and own the runtime child declaration; the page supplies the header and card.
