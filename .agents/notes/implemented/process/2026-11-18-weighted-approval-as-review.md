# Agent Note: Weighted approval becomes an approving review

Status: implemented

English | [中文](2026-11-18-weighted-approval-as-review.zh.md)

## Problem

The required `weighted approval` commit status carries an approval decision inside the CI check group. It stays `pending` until the policy holds, and issue #6719 recorded that a later `pull_request_target` run can leave the merge box at `Expected` while the API reports `success`, so a passing pull request stays blocked. The status also makes readers treat an approval wait as running CI, and it duplicates the repository's native review requirement with a custom status. The `weighted approval decision` check run added earlier only labels the same state; it does not remove the status gate or the suite-association race.

## Decision

The `weighted-approval` workflow writes no commit status and no check run. It evaluates the score with the same policy, then publishes the outcome through the approval App:

- An unmet policy creates or updates one conversation comment marked `<!-- weighted-approval -->`. The comment lists the score, counted approvals, remaining points, blocking change requests, delegated reviews still awaited, and reviews without write access.
- A met policy deletes that comment and submits an `APPROVE` review with the same marker. The publisher submits no second review when the latest marked review is already `APPROVED`.
- A draft, a blocking change request, or a score below the threshold dismisses every marked `APPROVED` review, then posts or keeps the comment. Drafts are never approved.
- An evaluation failure fails the workflow run without publishing a partial decision.

The publisher's own marked review is excluded from scoring, so it cannot supply the points it is evaluating. Delegation, author credit, production-line ownership, and the two-point threshold keep their existing rules.

The approval App token owns every read and write: reviews, comments, review dismissals, review requests, and GraphQL editor checks. It requests `Contents: write`, `Issues: write`, and `Pull requests: write`. GitHub counts an App approval toward a required review only while the App has write access to the repository, so Contents write is required; a missing permission fails the token step instead of publishing an approval that cannot satisfy the ruleset.

Branch rules remove the `weighted approval` status from the required-status-checks group. A separate ruleset, `Default + release branches — Weighted approval`, requires one approving review on the default branch and release branches. The `Default + release branches — Merge requirements` ruleset keeps its merge methods and review-thread resolution with `required_approving_review_count` set to `0`. The approval requirement is therefore its own requirement group; it is not a CI check.

## Verification

The approval policy suite runs 82 keyless tests with `node --test .github/review-ownership/check-approval.test.mjs`, covering comment creation, update and removal, approving-review submission and deduplication, retraction on a score regression and on a draft, exclusion of the publisher's own review from scoring, delegation, scoring, and API failures. The workflow test in `scripts/ci-workflow.spec.ts` pins the trusted checkout, the no-permission review-event handoff, the App token scopes, the events, and the single evaluation command.

The live acceptance path requires the App installation to grant Contents, Issues, and Pull requests write. After this decision merges, remove the retired status requirement, create the separate ruleset, and open a pull request with two approval points. The App submits one `APPROVE` review, the status comment disappears, and `gh pr view <number> --json reviewDecision` reports `APPROVED`.

## Alternatives considered

**Keep the commit status and add the comment.** Rejected because the status was the failure being removed: it remains a CI entry that blocks merges, and issue #6719 shows that a later `pull_request_target` run can still render it as expected. The [archived status-gate decision](../../archived/process/2026-10-20-weighted-approval-status-gate-with-check-run-label.md) records the measured check-run association.

**Require an App-published check run instead of a review.** Measured on 2026-10-20 and 2026-10-21: a check run created with the workflow token attaches to the earliest Actions suite on the head, and when that suite belongs to the `pull_request_target` publisher the merge box omits it; a required check run published with the job token stayed `Expected` while the REST API and `gh pr checks` listed it complete, and two pull requests needed an administrator bypass. A run published by the approval App fixed the label, not the requirement: the approval would still sit in the checks group.

**Approve with `GITHUB_TOKEN`.** Rejected because GitHub blocks workflow-token approvals by default and they do not count toward required reviews. A separate App identity is required.

**Require a team review.** Rejected because a ruleset's `required_reviewers` accepts teams only; the approval publisher is an App installation, not a team member.

**Keep both the status and the review.** Rejected because two gates leave the status failure in place and report the same decision twice.

## Consequences

Any write-capable approval satisfies the required review, including a human approval below two points. The weighted score decides when the App supplies its approval and when the comment reports a deficit; it is no longer an additional merge gate above the native review. A pull request that a maintainer wants to hold below two points therefore needs an explicit change request, not the absence of an approval.

The approval App now needs Contents write, which is broader than the Checks write it had. The App approval persists across later pushes because stale-review dismissal stays off; the next evaluation checks the score again and retracts the approval when the policy stops holding. GitHub rejects an approval of a pull request the App authored, so such a pull request needs a human approval.

Removing the status removes the `Expected` failure mode from later `pull_request_target` runs. The workflow's own job is no longer a required check; a failed evaluation appears as a failed run on the pull request checks list without blocking a merge that already has its required approval.
