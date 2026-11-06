---
kind: upgrade-guide
description: "ForgeProvider.diff and ctx.forge.diff take the head commit to read, ForgeFailure gains the stale code, and ChangeRequestSnapshot gains threadsTruncated."
---

# Forge diffs read one head commit

English | [中文](guide.zh.md)

## Change

`ForgeProvider.diff(ref, signal)` becomes `diff(ref, headSha, signal)`, and `ctx.forge.diff(ref, signal)` becomes `ctx.forge.diff(ref, headSha, signal)`. A provider returns a patch only when it describes `headSha`; when the change request's head is another commit, it resolves to a `ForgeFailure` whose code is the new `stale`. `ctx.forge.diff` then polls the change request again at once when it is watched. The GitHub provider reads the head before and after `gh pr diff` and returns `stale` when either read names another commit.

`ForgeFailure['code']` gains `stale`. `ChangeRequestSnapshot` gains the required `threadsTruncated: boolean`, which marks `unresolvedThreads` as a lower bound when the provider counted only some review threads.

The `forgePanel.changeRequestDiff` Remote rejects with `forgePanel/stale-head` instead of returning a patch read at another head.

This affects third-party `ForgeProvider` implementations registered with `ctx.forge.register`, code that calls `ctx.forge.diff` or `forgePanel.changeRequestDiff`, code that builds `ChangeRequestSnapshot` values, and code that switches exhaustively over `ForgeFailure['code']`. All types come from `@deepseek-ai/dsh-experimental-forge`.

## Migration

1. In a `ForgeProvider`, add the `headSha: string` parameter to `diff` before `signal`. Return the patch only when the host computed it at `headSha`; otherwise return `{ code: 'stale', message }`. A host whose diff endpoint takes no commit can read the head before and after the diff, as [`GitHubProvider.diff`](../../../../packages/experimental/forge-github/src/provider.ts) does.
2. Pass the head commit to every `ctx.forge.diff` call, usually `ctx.forge.latest(ref)`'s `snapshot.headSha`. On `stale`, wait for a later status and read again at its head; do not cache the result under the old head.
3. Set `threadsTruncated` in every `ChangeRequestSnapshot` a provider builds: `false` when `unresolvedThreads` counts every review thread.
4. Handle `stale` wherever code switches exhaustively over `ForgeFailure['code']`, and `forgePanel/stale-head` wherever a caller of `forgePanel.changeRequestDiff` distinguishes Remote error codes.
5. Run your type check; it succeeds when every `diff` implementation and call passes a head commit, every snapshot sets `threadsTruncated`, and no `ForgeFailure` code is unhandled.
