---
kind: upgrade-guide
description: "Archiving a Session can remove its clean UI-created worktree while retaining the branch."
---

# Worktree cleanup on archive

English | [中文](guide.zh.md)

## Change

Archiving a Session previously retained its checkout. With the Forge bundle enabled, archiving can now remove a clean, unused worktree created by the New Session UI. Branches and commits remain. Dirty, ignored, shared, active, or uncertain checkouts remain without an extra prompt; existing archived Sessions are not swept. See the [Forge panel behavior](../../../../packages/experimental/client-ui-forge/README.md).

## Migration

1. If a checkout must remain available outside DSH, keep its Session unarchived or lock it with `git worktree lock <path>` before archiving.
2. To resume an archived Session whose checkout was removed, unarchive it and use **Restore worktree**. The retained branch is checked out at the recorded path.
3. Confirm the branch and commits are present with `git branch --list` and that **Restore worktree** makes the recorded checkout available. Session logs require no migration.
