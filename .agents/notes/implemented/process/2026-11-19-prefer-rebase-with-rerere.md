# Agent Note: Prefer rebase with rerere for PR refreshes

Status: implemented

English | [中文](2026-11-19-prefer-rebase-with-rerere.zh.md)

## Problem

The [native stack decision](2026-08-02-native-github-stacks-and-optional-rebases.md) allows merge-forward and rebase equally for standalone and stacked PR branches. Agents therefore pick a history per refresh, and long-lived branches accumulate merge commits that reviewers must skip. Rebasing also asks again for conflict resolutions already made when a rebase is aborted and retried, when a stack child is rebased after its parent was rewritten, or when several commits of one rebase touch the same hunk.

## Decision

Agents refresh standalone and stacked PR branches by rebase, including after review. Before rebasing, the agent enables, once per clone, Git's reuse of recorded resolutions with `git config rerere.enabled true`, so Git records each resolved conflict and applies the recorded resolution when the same conflict recurs in a later rebase. The agent leaves `rerere.autoUpdate` unset, so Git leaves a replayed resolution unstaged for inspection; the agent reviews and stages it before continuing the rebase.

Merge-forward is used only when the PR author explicitly asks for it. The incremental merge-forward procedure and its rule to preserve an in-progress checkpoint before taking a newer base remain available for that case.

Lease protection is unchanged: a standalone rewrite publishes with `--force-with-lease=<branch>:<observed-oid>`, `gh stack push` and `gh stack sync` supply lease protection for their managed branches, and raw `--force` is forbidden. The native stack decision continues to own stack linkage, landing, and post-rewrite review audits.

## Alternatives considered

**Keep merge-forward and rebase equally allowed.** This leaves the history choice to each refresh and keeps the merge commits the rebase preference removes.

**Require rebase without exception.** A PR author can have a reason to keep merge checkpoints, such as preserving a large completed conflict resolution as a recovery point; the author request keeps that option.

**Rebase without rerere.** Retried rebases and stack cascades would ask for conflict resolutions already made, which costs time and can produce inconsistent resolutions.

## Consequences

- PR branches keep linear history, and reviewers see the branch's own commits on top of the current base.
- Every refresh rewrites commit OIDs, so the post-rewrite audit of heads, review threads, approvals, mergeability, and checks applies to every refresh.
- A recorded resolution can apply to a conflict whose correct resolution changed; the agent still inspects every replayed resolution before staging it.
- Recorded resolutions live in `rr-cache` under the repository's common Git directory, so linked worktrees of one clone share them and other clones do not.
