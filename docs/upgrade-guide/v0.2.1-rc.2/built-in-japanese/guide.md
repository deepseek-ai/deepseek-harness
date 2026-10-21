---
kind: upgrade-guide
description: "Built-in Japanese registrations conflict with third-party Japanese language packs."
---

# Japanese is a built-in language

English | [中文](guide.zh.md)

## Change

The locale plugin registers the `ja` language and Japanese dictionaries for `common` and `settings.locale`. Third-party language packs following the previous Japanese README example now fail with an already-registered language or dictionary error.

## Migration

1. In the language pack's client entry, remove `ctx.locale.addLanguage({ id: 'ja', ... })` and registrations for `common` and `settings.locale` under `ja`. Remove other Japanese dictionary registrations whose namespaces are now supplied by built-in plugins; keep translations for namespaces owned by your own plugins.
2. If the pack represents a distinct language variant, register a separate BCP 47-style id, such as `ja-JP`, for both the definition and its dictionaries instead of `ja`.
3. Reload the application with the pack enabled. Confirm it starts without duplicate-registration errors and that selecting the intended language displays its translations.
