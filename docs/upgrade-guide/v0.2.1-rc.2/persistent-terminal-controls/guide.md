---
kind: upgrade-guide
description: "Persistent-terminal bundle controls leave the Plugins page; profile configuration still enables and disables the bundle."
---

# Manage persistent terminals through profile configuration

English | [中文](guide.zh.md)

## Change

Web and Desktop no longer show the persistent-terminal bundle in Plugins lists or detail pages, including for profiles that already enabled it. The package and existing activation remain intact. The minimal preset's own persistent shell is independent of this bundle.

## Migration

1. To keep an existing selection, no action is required. To change it, open `$DSH_HOME/profiles/<name>/package.json`, where the default home is `~/.dsh` and `<name>` is the running profile, such as `web` or `desktop`.
2. Remove `@deepseek-ai/dsh-experimental-terminal-bundle` from `dsh.profile.bundles` to disable it, or add it to enable it. Keep the other entries and dependencies intact.
3. Restart the same profile to apply the selection. For a CLI-managed profile, run `dsh --profile <name> --dump-config`: the `optional-persistent-terminals` group is present only when the bundle is selected. See the [profile reference](../../../../apps/cli/reference/README.md#profile-boot).
