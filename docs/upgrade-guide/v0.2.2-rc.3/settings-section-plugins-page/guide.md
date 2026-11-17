---
kind: upgrade-guide
description: "Settings → Built-in plugins, its two packages, and the `settings.plugins.tab` slot are removed; plugin settings pages also appear on the Plugins page."
---

# Built-in plugins section removal

English | [中文](guide.zh.md)

## Change

**Settings → Built-in plugins** and its packages `@deepseek-ai/dsh-client-ui-settings-plugins` and `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` are removed, together with the `settings.plugins.tab` slot and `SettingsPluginsTabOwnerProps`. **Settings → Plugins** opens the Plugins page instead. `settings.section` entries still appear in Settings. The Plugins page also shows an entry on the listed bundle row whose module is the registering package, or on that bundle's page, when the row or bundle registers no `plugins.row.config` or `plugins.bundle.config` of its own; there the entry's `close` returns to the view it was opened from instead of closing Settings. Both surfaces render entries through the `settings.section.view` Factory, which ui-settings-general registers and which declares `settings.section`.

## Migration

1. Remove both removed packages from profile manifests and from `cordis.yml` rows that name them.
2. Move any `settings.plugins.tab` contribution to a `settings.section` page or a Plugins page slot such as `plugins.bundle.config`.
3. A `settings.section` page whose `close()` call must leave Settings, such as after starting a Session, navigates there itself, because on the Plugins page `close()` only returns to the previous view.
4. Open the plugin's bundle on the Plugins page and confirm its settings page appears there, unless the row or bundle registers its own configuration, and in Settings.
