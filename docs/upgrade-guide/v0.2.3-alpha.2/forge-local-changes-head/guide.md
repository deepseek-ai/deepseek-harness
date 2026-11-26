---
kind: upgrade-guide
description: "forgePanel.diffBases and forgePanel.localCommits take a head argument after the Session."
---

# The local changes reads of the Forge panel name the branch they show

English | [中文](guide.zh.md)

## Change

The `forgePanel.diffBases` Remote took `(session, query)` and `forgePanel.localCommits` took `(session, base)`. Both now take a `head` right after the Session: `diffBases(session, head, query)` and `localCommits(session, head, base)`. `head` is `string | null`: the full ref of a branch under `refs/heads/` or `refs/remotes/` that the read shows in place of the Session's checked-out branch, or null for the Session's own checkout, which is what both methods read before.

`ForgeLocalScope`, the argument of `forgePanel.localDiff`, `forgePanel.localText`, and the local source of `forgePanel.changesLens`, gains an optional `head` with the same meaning on each of its four kinds. `ForgeBaseBranch` and `ForgeLocalDiff` gain an optional `worktree`. Two error codes are new: `forgePanel/head-missing` when the branch does not exist, and `forgePanel/no-working-tree` when a scope other than `branch` names a head that no worktree has checked out.

This affects code outside `@deepseek-ai/dsh-experimental-client-ui-forge` that calls `forgePanel.diffBases` or `forgePanel.localCommits`. Code that only builds `ForgeLocalScope` values or reads `ForgeBaseBranch` and `ForgeLocalDiff` is unaffected, because the new members are optional.

## Migration

1. In every `forgePanel.diffBases` call, pass `null` as the second argument, before the query: `diffBases(session, null, query, signal)`.
2. In every `forgePanel.localCommits` call, pass `null` as the second argument, before the base: `localCommits(session, null, base, signal)`.
3. Run your type check; it passes once both calls have the new argument. The reads return what they returned before.
