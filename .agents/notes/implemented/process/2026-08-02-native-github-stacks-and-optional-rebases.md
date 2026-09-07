# Agent Note: Native GitHub stacks and optional PR rebases

Status: implemented

English | [中文](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)

## Problem

A dependent PR chain represented only by base branches has no official stack identity. Landing it requires manually merging one PR at a time, preserving intermediate branches, retargeting every child, and reconstructing whether the chain survived. GitHub's native stacked-PR feature instead carries the order, applies trunk rules and CI to every layer, and owns bottom-up merges and retargeting.

A blanket prohibition on rewriting reviewed branches also excludes the native `gh stack` synchronization workflow, whose cascading rebase updates each active layer and publishes it with lease protection. Applying that prohibition only outside stacks would give standalone and stacked PRs inconsistent history choices.

## Decision

Every same-repository chain of two or more dependent PRs uses GitHub's official stack object before landing. Live `PullRequest.stack` and `stackEntry.position` fields are authoritative. An unstacked chain whose PRs have one author is linked automatically in bottom-to-top order with `gh stack link`; mixed or unavailable authors require user confirmation. Missing native support and cross-fork chains hard-stop. Existing membership in conflicting stacks or an official order that disagrees with the branch topology requires user direction before any stack is dissolved or rebuilt.

"Land the stack" merges the complete official stack through `gh stack merge <stack-number> --yes --merge`. A partial landing requires an explicit boundary PR and merges the bottom prefix through that PR. The workflow never falls back to per-PR `gh pr merge` and manual retargeting. A direct native merge is all-or-nothing; a merge queue may process the selected PRs in separate groups, so every selected PR must independently reach `MERGED` before the landing is complete.

Merge-forward and rebase are both allowed refresh histories for standalone and officially stacked PRs, including after review. A remote history rewrite uses an exact lease or the lease-protected `gh stack` push path and aborts if the remote moved; raw `--force` is forbidden. The [incremental base-retargeting decision](../../archived/process/2026-07-26-incremental-pr-base-retargeting.md) remains the owner of the merge-forward option.

Relevant checks normally run before publication. `gh stack sync` is the explicit exception because it fetches, cascade-rebases, and pushes as one operation: every rewritten layer is validated immediately afterward, and no affected PR merges until that evidence passes. After any rewritten push, current heads, unresolved review threads, approvals, mergeability, and checks are re-audited because earlier commit OIDs and inline anchors may be outdated.

## Verification

The [stack landing skill](../../../skills/dsh-merging-stacked-prs/SKILL.md) verifies native support, same-repository branches, live authors, official membership and order, merge range, and final merged state. The [stack review guide](../../../../docs/cookbook/responding-to-pr-review-on-a-stack.md) keeps fixes on their introducing layer and covers both propagation histories. The [pre-push workflow](../../../skills/dsh-pre-push-checks/SKILL.md) owns lease protection and immediate post-sync evidence.

## Alternatives considered

**Keep branch chains as the only stack representation.** This preserves the manual procedure but gives GitHub no stack object through which to show order, enforce trunk rules across every layer, or merge a range atomically.

**Adopt native stacks while forbidding their rebase commands after review.** This keeps commit OIDs stable but disables the official synchronization path when a stack is under active review and leaves standalone PRs under a different policy.

**Require rebase for every PR refresh.** A linear history is useful, but merge checkpoints remain a valid choice when preserving completed conflict resolution and its recovery point matters more than compact history.

**Automatically dissolve conflicting stacks.** This would make local branch inference override shared GitHub metadata and could disturb PRs or authors outside the requested chain; merged and queued entries cannot always be removed.

## Consequences

- Reviewers and automation receive GitHub's stack map, stack-wide rules, CI, and native merge state.
- A same-author legacy chain becomes official without an extra prompt, while mixed ownership and conflicting metadata retain a human decision boundary.
- Rebases can invalidate commit hashes, approvals, or comment anchors after review, so every rewritten push carries a live review and check audit.
- `gh stack sync` can briefly publish code whose local evidence is pending; the affected PRs remain blocked from merging until immediate post-sync validation passes.
- Merge-forward remains available and preserves completed checkpoints, at the cost of additional merge commits.
