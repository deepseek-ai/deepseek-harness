# Agent Note: Retarget PR bases incrementally

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-incremental-pr-base-retargeting.zh.md)

## Problem

A PR base can advance while its current tip is being merged into the PR branch. Restarting from the newer tip discards completed conflict resolution and validation. Rewriting a merge that is already pushed also erases reviewable history.

## Decision

When merge-forward is chosen, each observed base tip gets its own merge checkpoint. If the base advances during the work, finish and validate the merge already in progress, commit it, and push it when the task authorizes a push. Only then fetch and merge the newer base in a separate merge commit. Do not abandon or rewrite a checkpoint within that merge-forward sequence.

The [native-stack and optional-rebase decision](2026-08-02-native-github-stacks-and-optional-rebases.md) also permits a lease-protected rebase for standalone or stacked PRs, including after review. This note owns the merge-forward path only. The [stacked-PR landing skill](../../../skills/dsh-merging-stacked-prs/SKILL.md) selects either history under the root [AGENTS.md](../../../../AGENTS.md), and the [stack review guide](../../../../docs/cookbook/responding-to-pr-review-on-a-stack.md) owns propagating fixes through dependent layers.

## Alternatives considered

**Abort and restart from the newest base.** This discards resolved conflicts and completed validation, repeats work, and removes a useful recovery point.

**Fold both base tips into one rewritten merge.** This hides the order in which conflicts were resolved and requires rewriting remote history if the first merge was pushed.

## Consequences

- A PR can carry several base-merge commits when its base advances repeatedly.
- Completed work remains reviewable and recoverable instead of being discarded.
- Merging a newer base changes the combined tree, so the relevant checks run again before the next push.
