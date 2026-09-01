# Agent Note: Event-directed PR review status commands

Status: implemented

English | [中文](2026-08-10-event-directed-pr-review-status.zh.md)

## Problem

The Issue Project status records who owns the next step of resolving work. Aggregate pull-request review state answers whether GitHub considers the pull request mergeable, but it cannot represent that handoff: an earlier `CHANGES_REQUESTED` review can remain effective after the author fixes the code and requests review again.

A monotonic projection also cannot return an automation-owned Issue from `In review` to `In progress` when a reviewer requests changes. Reconstructing review rounds or reviewer blockers would add state that the required two-event contract does not need.

## Decision

The Issue lifecycle workflow treats review webhooks as commands. `pull_request.review_requested`, including a repeated request, targets `In review`. `pull_request_review.submitted` targets `In progress` only when `review.state` is `changes_requested`; the submitted event remains necessary because a reviewer can request changes without an earlier review-request event. Approved and commented submissions run their lifecycle job but no-op (they never reach the Project token step), while dismissed reviews are not subscribed.

Ordinary subscribed pull-request events remain forward-only implementation signals: they can move `Inbox`, `Backlog`, or `Ready` to `In progress`, but they cannot move `In review` backward. Review-request commands can move any earlier active status to `In review`. Changes-requested commands can move earlier active statuses forward to `In progress` and can move `In review` back only when the latest status event for the target Project was written by the configured lifecycle actor. A human or unknown latest actor preserves the current status.

The status projection resolves only exact same-repository `Fixes`, `Closes`, or `Resolves` references. It does not alter terminal statuses, add an Issue with no Project status, depend on PR metadata validity, query `reviewDecision`, reconstruct review rounds, look up pull requests from Issues, or run a scheduled reconciler. [PR-opened Issue start dates](2026-08-31-pr-opened-issue-start-dates.md) own the separate date initialization for every same-repository Issue reference.

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) remains unsubscribed from `pull_request.ready_for_review`; neither event command depends on that action. [Issue policy](../../../../.github/workflows/issue-policy.yml) retains `ready_for_review` because it owns required-check enforcement when a human pull request enters review.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) pin the event-to-command mapping, the repeated-review-request transition after a changes-requested command, the changes-requested regression, terminal protection, and human override preservation. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the subscribed events, the job-level absence of `if` plus the step-level gate on the token/board steps (so approved/commented reviews pass without minting a token), and the separate `ready_for_review` policy trigger.

## Alternatives considered

**Derive status from `reviewDecision` or a reconstructed review round.** GitHub's aggregate can remain `CHANGES_REQUESTED` after a repeated review request, while a round reducer introduces reviewer and ordering semantics beyond the two explicit handoffs.

**Keep the forward-only projection.** Monotonic advancement protects later statuses, but it leaves an Issue in `In review` while the author is implementing requested changes.

**Apply every review command unconditionally.** This is the smallest event handler, but it lets automation overwrite a human-owned Project status. The latest target-Project status actor therefore guards the only backward transition.

**Restore `ready_for_review` or add a debounce queue.** Ready status carries neither review handoff, while another queue adds latency and control-plane state without changing either command.

## Consequences

A repeated review request moves an automation-managed resolving Issue to `In review` even while GitHub still reports an older blocking review. A later changes-requested review returns it to `In progress`; approval, comments, dismissal, pushes, and reviewer removal leave the most recent command's status unchanged.

The projection remains event-driven and does not repair an event that never runs. Replaying an old workflow run can replay its old command, and ProjectV2 still provides no atomic compare-and-swap between the latest-state read and mutation. Per-pull-request workflow concurrency and the human-ownership guard reduce these races without introducing durable lifecycle state.
