# Settings slot separator fixtures

These three opt-in client plugins contribute real rows to the General page. The [browser regression](../../settings-group-dividers.e2e.ts) loads them through the real Loader; shipped profiles do not include them.

| Plugin | Destination |
|---|---|
| [Legacy](fixture-settings-slots-legacy/client.js) | `settings.general.item` |
| [Grouped](fixture-settings-slots-grouped/client.js) | `settings.general.group.notifications.item` |
| [Custom](fixture-settings-slots-custom/client.js) | A plugin-owned child list in a custom group |

Each list includes an unbordered single row, a null registration, a Fragment with its own internal line between two rows, a row with its own bottom border, and a trailing null registration. Selecting the final row’s checkbox makes that registration return `null`. Checkboxes hold local React state only and never write product settings. Contributions and locale dictionaries follow the plugin effect lifetime.

The fixtures preserve the production General stylesheet. They expose the difference between DOM parentage and `display: contents`; see the [list item root documentation](../../../../../docs/subsystems/slots.md#list-item-roots).
