---
kind: upgrade-guide
description: "Desktop test builds require local opt-in before showing any Feishu update-policy authentication dialogs."
---

# Enable test update-policy authentication dialogs locally

English | [中文](guide.zh.md)

## Change

Test builds previously offered Feishu login after an unauthenticated startup or manual update-policy check. All test authentication dialogs now default to disabled, including manual checks and mandatory-update refreshes. Test gateway cookies do not survive restart. With login disabled, a gateway requiring authentication cannot provide new mandatory-update decisions; enable the setting, restart and sign in to obtain them. Authentication failures retain any mandatory block already known in the same process; production policy requests and product account login are unchanged.

## Migration

1. Launch the updated application once to create `app.getPath('userData')/desktop/settings.json` if missing. Existing files are retained, and a missing field defaults to `false`. See [local desktop settings](../../../../apps/desktop/README.md#local-desktop-settings) for platform paths and error recovery.
2. To permit Feishu login, set `updates.allowTestAuthPopupWindow` to `true` in that file, then fully quit and restart Desktop. An unauthenticated test-policy response can now offer login. Leave the default unchanged if no login dialogs are wanted.
3. To disable dialogs again, set the field to `false` and restart. Startup and manual checks must not show Feishu authentication dialogs. Updates still query policy, and authentication failures do not clear a known mandatory block.
