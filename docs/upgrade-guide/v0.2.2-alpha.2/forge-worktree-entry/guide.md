---
kind: upgrade-guide
description: "The Plugins page replaces the standalone Git worktrees card with Change requests & worktrees."
---

# One plugin entry for change requests and worktrees

English | [中文](guide.zh.md)

## Change

Web and Desktop use **Change requests & worktrees** to enable the review panel, the new-Session worktree option, and the model's `create_worktree` tool together. The separate **Git worktrees** card is hidden. Profiles that already enabled the Forge bundle also gain the model tool.

Existing profiles are not migrated automatically. A selected `@deepseek-ai/dsh-experimental-tool-worktree` bundle stays active even though its card is hidden, so turning off Forge does not disable that standalone tool. Selecting both it and `@deepseek-ai/dsh-experimental-forge-bundle` inserts duplicate `worktree` and `tool-worktree` ids, making those component controls read-only. Remove the standalone selection before using the unified switch.

## Migration

1. Stop Web or quit Desktop. Back up `$DSH_HOME/profiles/<name>/package.json` and its sibling `cordis.patch.yml`. Use `~/.dsh` when `DSH_HOME` is unset; the standard profile names are `web` and `desktop`. For a custom profile, use its name.
2. Edit `dsh.profile.bundles` in that `package.json`. Remove every `@deepseek-ai/dsh-experimental-tool-worktree` entry. To keep worktree support through the unified switch, add `@deepseek-ai/dsh-experimental-forge-bundle` once; if it is already selected, keep that entry. To disable both features, remove both bundle names. Preserve all other entries and fields.
3. Keep existing `cordis.patch.yml` overrides: the `worktree`, `tool-worktree`, and `optional-forge-panel` ids are unchanged. To use the Forge panel without exposing the model tool, add or update this entry in the existing patch list:

   ```yaml
   - id: tool-worktree
     disabled: true
   ```

4. Restart the application. In Plugins, confirm that **Change requests & worktrees** reflects your selection. With no disabling row override, enabling it provides the panel and `create_worktree`; turning it off removes both. Confirm that the profile lists no standalone worktree bundle. Existing worktrees, branches, and Session records are retained.

Headless profiles and custom compositions that need only the standalone tool can keep it; do not also select the Forge bundle. In Web or Desktop, that standalone selection remains hidden and must be managed through the profile file.
