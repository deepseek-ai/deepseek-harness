# Responding to review across a stacked PR chain

English | [中文](responding-to-pr-review-on-a-stack.zh.md)

Review comments may target several PRs in a dependent stack (`A ← B ← C …`). Keep that chain linked through GitHub's official stacked-PR feature. This guide owns review-fix placement and propagation; the [dsh-merging-stacked-prs](../../.agents/skills/dsh-merging-stacked-prs/SKILL.md) skill owns linkage checks and landing.

## Ground rules

1. **One worktree per PR branch.** Each PR's fixes happen in that PR's own worktree; parallel fixes never share a checkout.
2. **GitHub's stack object is authoritative.** Base branches establish the expected dependency order, while `PullRequest.stack` and `stackEntry.position` prove that GitHub recognizes it. Do not treat a matching branch chain as an official stack without checking those fields.
3. **A fix lands on the PR that INTRODUCED the issue, then flows up-stack.** When a comment on PR `B` points at code `B` introduced, fix it on `B` and propagate `B` into `C` — even if `C` also carries the file. Originating the fix downstream leaves `B` shipping the unfixed code and hides the fix from `B`'s reviewer.
4. **Each review fix remains a distinct commit.** A later rebase may change its OID, but do not amend a reviewed fix out of the branch history. Amend only your own not-yet-pushed, not-yet-reviewed work.
5. **Choose merge-forward or rebase deliberately.** Both histories are allowed after review. A rewritten push must be lease-protected and must abort rather than overwrite a concurrently advanced remote head; raw `--force` is forbidden.

## Resolve comments through the stack

1. Triage every comment on the merits before acting: verify the claim against the code — a reviewer flagging the right symptom can still misdiagnose the cause.
2. Map each accepted finding to its originating PR and fix it there.
3. Propagate the fixed layer through every affected child in order:
   - **Merge-forward:** merge the fixed parent branch into its child, validate the child, and continue upward. Preserve each in-progress checkpoint.
   - **Native cascading rebase:** use `gh stack rebase`, validate the rewritten layers, then publish with `gh stack push`; or use `gh stack sync`, which may publish first and therefore requires immediate post-sync validation under [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md).
4. Treat delegated fixes as trust-but-verify: a sub-agent's report describes intent, not necessarily what landed. Re-run the gates yourself on the actual tree, and for a regression guard, prove it FAILS on the unfixed code (introduce the regression, watch red, revert) — a guard that passes both ways guards nothing. A sub-agent that reframes a problem as already handled is a signal to dig in personally.
5. Reply in the review thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`), not as a top-level comment, stating the fix and the current commit or head that carries it.
6. After any rewritten push, re-read unresolved threads, approvals, mergeability, and checks. A force-pushed commit OID or outdated inline anchor is not current evidence that the finding remains resolved.
7. Land only through the official stack procedure. If the PRs are not yet linked, the landing skill automatically links a same-author chain, asks before linking mixed authors, and hard-stops when native stack support is unavailable.

## Verify

- Every fixed PR's current diff contains the intended correction at the layer that introduced the issue.
- GraphQL reports one official stack in the expected order, and each child diff against its parent shows only that child's changes.
- Unresolved threads, approvals, mergeability, and checks were re-audited after every rewritten push.
- The relevant gates pass on every affected PR in the stack, not just the top.
