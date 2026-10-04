---
kind: upgrade-guide
description: "The Web composition no longer carries the Schedule rows; the Automation tasks optional bundle inserts them."
---

# Schedule moves into the Automation tasks optional bundle

English | [中文](guide.zh.md)

## Change

In v0.1.7-rc.2, `@deepseek-ai/dsh-web-app` carried the `time-context`, `schedule`, and `ui-schedule` rows with `disabled: true`. Turning Schedule on in the Plugins page, or by hand, wrote id-targeted overrides such as `- id: schedule` with `disabled: false` into `$DSH_HOME/profiles/<name>/cordis.patch.yml` or a `--patch` overlay.

The next release removes the three rows from the Web composition. `@deepseek-ai/dsh-experimental-schedule-bundle`, shown as Automation tasks in the Plugins page's Official group, inserts them. Every installation ships the bundle switched off.

Profiles that enabled Schedule by id lose it after upgrading: the loader warns `patch: entry schedule not found` (and the same for `time-context` and `ui-schedule`), the `schedule_*` tools and the Automation tasks page disappear, and stored reminders stop being delivered. Stored tasks and delivery records remain on disk.

## Migration

1. Open Plugins, find Automation tasks in the Official group, and switch it on. The switch appends `@deepseek-ai/dsh-experimental-schedule-bundle` to `dsh.profile.bundles` in `$DSH_HOME/profiles/<name>/package.json`; for a profile edited by hand, add that entry yourself.
2. Keep existing overrides that set other fields on `schedule`, `time-context`, or `ui-schedule`, such as `deliveryHistoryDays`; they apply again once the bundle inserts the rows. Overrides that only set `disabled: false` are redundant and can be deleted.
3. Confirm: restart `dsh web`, check that startup logs no `patch: entry ... not found` warning for the three ids, and that the sidebar shows Automation tasks with the previously stored reminders.
