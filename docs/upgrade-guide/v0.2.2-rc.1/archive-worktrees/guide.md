---
kind: upgrade-guide
description: "Archiving a Session can remove its clean worktree while retaining the branch, and the Forge bundle mounts one worktree service."
---

# Worktree cleanup on archive

English | [中文](guide.zh.md)

## Change

Archiving a Session previously retained its checkout. The worktree service now records each checkout it creates as a `plugin:worktree/created` record and, when the Session that created one is archived, removes it with a non-force `git worktree remove` when no unarchived Session refers to it, its creator's policy is not read-only, and Git finds no tracked changes, untracked files, hidden index flags, submodules, locks, or detached HEAD. Ignored files such as `node_modules` do not retain it. Branches and commits remain. The service's `retainOnArchive` setting, off by default, keeps every checkout instead. Checkouts created before this release have no such event and are never swept, nor are Sessions archived earlier. See the [worktree service](../../../../packages/experimental/worktree/README.md).

The Forge bundle mounts one `worktree` service for both the panel and the `create_worktree` tool. The `forge-worktree` row and the `optional-forge-panel` group that isolated a second service are gone; the panel is the top-level `forge-panel` row.

## Migration

1. If a checkout must remain available outside DSH, keep its Session unarchived, lock it with `git worktree lock <path>` before archiving, or turn on **Keep worktrees when archiving** on the Forge bundle's worktree row of the Plugins page (`retainOnArchive`), which keeps every checkout. Ignored files are not kept.
2. To resume an archived Session whose checkout was removed, unarchive it and use **Restore worktree**. The retained branch is checked out at the recorded path.
3. In a profile's `cordis.patch.yml`, move any `forge-worktree` override to the `worktree` row and any `optional-forge-panel` override to the `forge-panel` row; a `disabled: true` on `forge-panel` turns off the panel alone.
4. Confirm the branch and commits are present with `git branch --list` and that **Restore worktree** makes the recorded checkout available. Session logs require no migration.
