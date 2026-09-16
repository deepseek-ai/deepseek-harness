# Agent Note: PR-scoped approval delegation

Status: implemented

English | [中文](2026-09-15-pr-approval-delegation.zh.md)

## Problem

A reviewer may trust another reviewer to decide a particular PR while retaining the score associated with their own repository role and code ownership. Counting both the original approval and transferred points would inflate that reviewer's contribution.

## Decision

The [approval policy](../../../../.github/review-ownership/README.md#delegating-points) accepts `/delegate @username` in PR conversation comments. Each eligible sender's points follow the named recipient's effective approval, once, using the sender's weight. Delegation applies only to that PR and only between write-capable accounts other than the PR author. Received points cannot be forwarded. The command dismisses the sender's prior approvals and change requests through GitHub. Other effective blocking reviews still follow [blocking-review policy](2026-09-09-blocked-weighted-approvals-remain-pending.md).

The latest surviving eligible command in comment creation order determines the recipient. Edited commands require the latest editor to match the author’s immutable account ID; other writers cannot transfer or cancel that author’s points by editing a comment. A self-delegation or a subsequently submitted review restores the sender's own decision. Comment-only reviews also reclaim the points; pending reviews do not. Equal timestamps favor the review, and subsequent dismissal cannot revive the delegation. A fresh command after the review can delegate again. Edits and deletions recompute from current comments, including restoration of older commands. The trusted publisher filters conversation comment changes for `/delegate`, resolves the live open PR head, and reads comments and editor identity as API data. Every evaluation reconciles active eligible commands, dismissing prior decision reviews and requesting recipients unless already approved or requested. This covers replaced queued events and draft-to-ready transitions; other requested reviewers remain unchanged. Scores refresh after dismissal, which retains the old submission timestamps and cannot cancel delegation. Removing the recipient's approval removes counted points while retaining delegation for their next approval. Drafts do not dismiss or request reviews. Dismissal failures fail evaluation; request failures are logged separately and retried on later evaluations. Closed or merged PRs are skipped before status writes and dependency setup. It preserves the separate [review-workflow validation](2026-09-10-approval-review-workflow-identity.md).

## Alternatives considered

**Count delegation as immediate approval.** This would approve a PR before the chosen reviewer makes a decision.

**Add the sender's score without removing their direct contribution.** This would count one account twice and weaken the approval threshold.

**Forward received points through delegation chains.** This would let a recipient transfer another person's points to an account that person did not name.

**Only suppress the sender's old decision in the score.** GitHub would retain the old approval or blocking review. Dismissing it keeps native review state consistent with the handoff.

**Keep delegation after the sender reviews.** A submitted review expresses the sender's own decision, so continuing to use someone else's approval would disregard it.

**Persist commands separately from comments.** This would require additional storage and reconciliation for edits and deletions; current comments already provide an inspectable record.

## Consequences

Delegation preserves the sender's [production ownership weight](2026-09-11-production-blame-approval-weight.md) and the independent author-credit rule. Each evaluation needs complete comment and editor history and current participant permissions; missing history fails evaluation. Editing an older command does not change its priority, and deleting a newer command may reactivate an older one. Policy tests cover score conservation, review-driven revocation, prior-review dismissal, permission filtering, review requests, blockers, pagination, and failure publication; workflow tests pin trusted execution and shared per-PR concurrency. Native stale-review and latest-push requirements remain GitHub's responsibility.
