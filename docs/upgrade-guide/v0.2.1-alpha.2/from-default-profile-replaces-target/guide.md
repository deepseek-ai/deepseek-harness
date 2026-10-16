---
kind: upgrade-guide
description: "`--from-default-profile` now replaces an existing custom profile instead of refusing it."
---

# `--from-default-profile` replaces an existing profile

English | [中文](guide.zh.md)

## Change

`dsh --profile <name> --from-default-profile <template>` used to fail with `profile "<name>" already exists` when the target profile existed, and refused a residual target directory. It now replaces the target directory with a fresh copy of the template every time, then boots it or, with a config-dump flag, prints the composition. The previous directory is deleted, including its `package.json` dependencies, installed `node_modules`, and `cordis.patch.yml`. Shipped profile names, in any letter case, are still rejected as targets.

This affects anyone who repeats the command, such as `dsh rescue --from-default-profile web`, in scripts or shortcuts and expects later runs to keep the profile's plugins or patch.

## Migration

1. To boot an existing profile without resetting it, drop the option: run `dsh rescue` instead of `dsh rescue --from-default-profile web`.
2. To keep local changes across a reset, copy `$DSH_HOME/profiles/<name>/cordis.patch.yml` before running the command, then reinstall the profile's plugins with `dsh plugin --profile <name> add <package>` and restore the patch.
3. Confirm the migration: after `dsh rescue --from-default-profile web --help`, `$DSH_HOME/profiles/rescue/package.json` lists no dependencies.
