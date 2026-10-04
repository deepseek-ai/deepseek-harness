---
kind: upgrade-guide
description: "The Automation tasks optional bundle is removed; the Web composition mounts Schedule itself."
---

# Automation tasks bundle removed

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, switching on Automation tasks in the Plugins page appended `@deepseek-ai/dsh-experimental-schedule-bundle` to `dsh.profile.bundles` in `$DSH_HOME/profiles/<name>/package.json`. That bundle inserted the `time-context`, `schedule`, and `ui-schedule` rows.

The next release removes the bundle. `@deepseek-ai/dsh-web-app` mounts `schedule` and `ui-schedule` in every Web profile, and the `standard`, `cordis`, and `ptc` presets declare the clock reading and the four `schedule_*` tools; `minimal` declares neither ([details](../../../subsystems/schedule.md)).

Loading a profile removes `@deepseek-ai/dsh-experimental-schedule-bundle` from its `dsh.profile.bundles` and rewrites `package.json`; other manifest fields are kept. Stored tasks and delivery records stay on disk and remain in use.

## Migration

1. Start `dsh` once with each affected profile; no manual edit is needed. A profile directory that another tool writes must drop the entry from `dsh.profile.bundles` itself.
2. Keep overrides on `schedule` and `ui-schedule` in `cordis.patch.yml` or a `--patch` overlay; the Web composition carries those rows. A top-level override on `time-context` no longer matches a row, because the clock row belongs to the presets ([time-context](../../../../packages/context/time-context/README.md)); delete it.
3. Confirm: `dsh.profile.bundles` no longer lists the bundle, the Plugins page shows no failed Automation tasks entry, and the sidebar shows Automation tasks with the previously stored reminders.
