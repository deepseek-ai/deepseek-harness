---
kind: upgrade-guide
description: "Built-in language registrations conflict with third-party language packs using the same ids."
---

# Built-in languages replace duplicate language packs

English | [中文](guide.zh.md)

## Change

The locale plugin registers `ja`, `es`, `fr`, `de`, `ru`, and `pt`, with dictionaries for `common`, `settings.locale`, and the built-in UI plugins. Third-party language packs using these ids now fail with an already-registered language or dictionary error, including packs based on the earlier Japanese or French README examples.

## Migration

1. In the language pack's client entry, remove `ctx.locale.addLanguage(...)` for these ids and dictionary registrations in namespaces supplied by built-in plugins. Keep translations for namespaces owned by your own plugins.
2. If the pack represents a distinct language variant, register a separate BCP 47-style id, such as `fr-CA`, for both the definition and its dictionaries instead of the built-in id.
3. Reload the application with the pack enabled. Confirm it starts without duplicate-registration errors and that selecting the intended language displays its translations.
