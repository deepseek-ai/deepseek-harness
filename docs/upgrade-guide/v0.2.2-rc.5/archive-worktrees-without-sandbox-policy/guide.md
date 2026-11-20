---
kind: upgrade-guide
description: "Archive cleanup removes a checkout whose creator's sandbox policy is read-only, and runs its Git commands outside the sandbox."
---

# Archive cleanup ignores the creator's sandbox policy

English | [中文](guide.zh.md)

## Change

[v0.2.2-rc.1](../../v0.2.2-rc.1/archive-worktrees/guide.md) retained an archived Session's checkout while its creator's sandbox policy was read-only, and ran the removal's Git commands under that policy. Archiving now counts as the user's authorization to remove the checkout: cleanup reads no sandbox policy, removes the checkout whatever the creator's mode, and runs `git status` and `git worktree remove` outside the sandbox with the Host user's permissions. Git reads the repository's configuration as usual; hooks and the filesystem monitor stay disabled.

The checks that bound removal are unchanged: the checkout lies in the configured pool of its source checkout, is registered on its recorded branch without locks or a detached HEAD, and has no tracked changes, untracked files, or initialized submodules; no unarchived Session refers to it; the branch and its commits remain.

You are affected when you relied on a read-only creator to keep its checkout after archiving, or on the sandbox to confine cleanup.

## Migration

1. To keep every checkout on archive, set `retainOnArchive: true` on the worktree service, in `cordis.yml` or from the Forge panel's switch on the Plugins page.
2. To keep one checkout, leave a tracked change or an untracked file in it, or keep an unarchived Session working inside it, before archiving the creator.
3. Archive a test Session that created a clean worktree, then check `ctx.worktrees.cleanupOf(sessionId, null)`: `removed` confirms the new behavior, and `null` confirms `retainOnArchive` is in effect.
