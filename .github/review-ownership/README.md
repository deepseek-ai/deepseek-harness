# Pull-request approval policy

## Summary

The [`weighted-approval` workflow](../workflows/weighted-approval.yml) evaluates an approval score from the repository default branch. An unmet policy gets one status comment; a met policy gets an approving review from the approval App. Branch rules require that review in a separate ruleset instead of a CI status. Reviewers are chosen manually; an eligible delegation command requests review from its recipient.

## Table of Contents

- [Approval scoring](#approval-scoring)
- [Publishing the outcome](#publishing-the-outcome)
- [Required review ruleset](#required-review-ruleset)
- [Delegating points](#delegating-points)
- [Security](#security)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="approval-scoring"></a>

## Approval scoring

The policy holds when counted approvals reach two points, the pull request is ready for review, and no write-capable reviewer has an effective `CHANGES_REQUESTED` review. The workflow evaluates a pull request when it opens, synchronizes, reopens, becomes ready, becomes a draft, or is edited, including a base-branch change. Review submissions, edits, and dismissals reach the publisher through the no-permission [`weighted-approval-review-event` workflow](../workflows/weighted-approval-review-event.yml); its validated run title and current head identify the pull request. Conversation comment events run the publisher only when the current or previous body contains `/delegate`. Closed or merged pull requests and superseded heads are skipped before API writes or dependency setup. Pull-request, review, and comment events share one concurrency group per pull request.

Reviewers whose calculated base repository permission is `write` or `admin` count. The [approval policy](approval-policy.json) gives `@07akioni`, `@CreatixChu`, `@imccyu`, `@LegGasai`, `@tianyicui`, `@tianyicui-bot`, `@turtle1999`, and `@turtle2099` two points each; every other write-capable reviewer gets one point. The pull-request author’s own review and reviewers without write permission do not count. The approval App’s own review carries a marker and is excluded from scoring, so it cannot complete the threshold it is evaluating.

The PR author contributes `min(100, mergedPRCount) × 11 / 1000` points: 0 merged PRs → 0 points, 50 → 0.55, and 100 or more → 1.1. The publisher counts only merged PRs in this repository using the author’s immutable account ID, excluding the current PR. It stops at 100 matches and rejects incomplete history responses. Counts refresh at the next subscribed evaluation event. Author credit is separate from reviewer approvals and cannot satisfy the two-point requirement alone; the author’s own review remains excluded. Human and bot authors, including Dependabot, use the same rule, except that PRs authored by `@turtle2099` receive a fixed 0.2 points without a history lookup. Drafts, blocking reviews, and sufficient reviewer points skip history lookup; logs mark credit as not evaluated. Otherwise, logs show author credit and the capped count, or the fixed credit, separately. Below the cap, counting may scan the repository’s entire merged history; a failed required lookup fails the run.

A one-point approval receives weight `min(2, 1 + 4 × ownedLines / totalLines)` from modified or deleted old production-code lines, attributed by `git blame` at the merge base of the live base branch and exact reviewed head. Ownership of 0%, 12.5%, and 25% gives 1, 1.5, and 2 points; higher ownership remains capped at 2. The success threshold remains 2 total points, without rounding the score. New lines do not enter the denominator, and an empty denominator gives no boost. Existing two-point weights remain unchanged. GitHub commit-author accounts identify reviewers across author emails; unlinked authors remain in the denominator without contributing to a reviewer. The publisher logs measured ownership. It skips attribution when reviewer points plus author credit already meet the threshold or a blocking review exists. Displayed scores use at most three decimal places; the decision uses unrounded scores with a tolerance of `1e-12` points for floating-point error. The curve endpoints come from the policy’s default and required points.

Production source means supported code files under `src/` in `packages/`, `apps/`, `python/`, and `native/`, plus the Desktop renderer, Python interpreter scripts, and committed runtime/packer launchers. The [classifier](blame-production.py) excludes documentation, tests, fixtures, snapshots, test support (including `src/testing/` and `src/testing.ts`), examples, generated source, dependencies, vendored code, declarations, comments, and blank lines. Pygments lexers distinguish comments from strings; mixed code/comment lines count, as do C preprocessor directives. Classification uses the old path and content, so changes to the PR’s file locations or generated headers cannot remove old lines from the denominator. Pure renames have no changed lines; renames with edits use the old path for blame.

Each reviewer contributes only the current `APPROVED` or `CHANGES_REQUESTED` decision that GitHub returns. A `DISMISSED` record clears that reviewer's standing decision, including earlier approvals. Comment-only and pending records do not replace a decision. Reviews from deleted accounts and reviewers without current repository access do not count. The workflow does not invalidate an approval by its review commit; the repository's native pull-request rules own stale-review and latest-push requirements.

The publisher fetches every review and conversation comment, then resolves current repository permission before deciding. Permission changes take effect on the next subscribed event.

<a id="publishing-the-outcome"></a>

## Publishing the outcome

When the policy is unmet, the approval App writes one conversation comment containing `<!-- weighted-approval -->`. The comment carries the current score, counted approvals with their ownership or delegation, remaining points, blocking change requests, delegated reviews still awaited, and reviews without write access. Each evaluation updates that comment in place, and the publisher deletes it when the policy holds or the pull request becomes a draft. A comment marker copied by another account is ignored because the publisher only edits comments from a bot account.

When the policy holds, the publisher deletes the status comment and submits an `APPROVE` review carrying the same marker and the final score. It submits no review when the latest marked review is already `APPROVED`. When the policy stops holding, or the pull request becomes a draft, the publisher dismisses every marked `APPROVED` review before publishing the unmet state. The dismissal message is `Weighted approval no longer holds.`.

Drafts are never approved: the publisher retracts a previous approval and removes the status comment. An evaluation failure fails the workflow run without writing a partial decision; the previous comment or approval stays as the last completed decision.

<a id="required-review-ruleset"></a>

## Required review ruleset

Branch rules must not require the retired `weighted approval` commit status, and the `weighted approval decision` check run no longer exists. The approval is a native pull-request review, so the requirement lives in its own ruleset rather than the required-status-checks group.

Create the ruleset `Default + release branches — Weighted approval` with the same branch conditions as the merge-requirements ruleset and one approving review:

```json
{
  "name": "Default + release branches — Weighted approval",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH", "refs/heads/release/*"],
      "exclude": ["refs/heads/release/*-to-master", "refs/heads/release/session-log-*"]
    }
  },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["squash", "merge"],
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": false,
        "required_reviewers": []
      }
    }
  ]
}
```

Remove `weighted approval` from the required status checks in `Default + release branches — Merge requirements`, and set that ruleset’s `required_approving_review_count` to `0`; it keeps its merge methods and review-thread resolution. The two rulesets then enforce separate requirement groups: CI checks in one, the approving review in the other. The required review counts any write-capable approval, including the App’s, so the weighted score decides when the App supplies the approval rather than adding a second approval requirement.

GitHub counts a GitHub App approval toward required reviews only while the App has write access to the repository. The approval App therefore needs `Contents: write`, `Issues: write`, and `Pull requests: write`, with `vars.DSH_APPROVAL_APP_CLIENT_ID` and `secrets.DSH_APPROVAL_APP_PRIVATE_KEY` configured. The workflow requests exactly those permissions when it mints the token, so a missing permission fails the job instead of publishing an approval that cannot satisfy the ruleset. Keep “Allow GitHub Actions to create and approve pull requests” disabled; the App token supplies the approval, not `GITHUB_TOKEN`.

After the ruleset exists, open a pull request with two approval points. Expected: the App submits one approving review, the status comment disappears, and `gh pr view <number> --json reviewDecision` reports `APPROVED`. A pull request below two points keeps the status comment and has no App approval.

<a id="delegating-points"></a>

## Delegating points

Post `/delegate @username` as the entire text of a PR conversation comment to transfer your reviewer points to that user's effective `APPROVED` decision on this PR. For example, `/delegate @turtle1999` lets @turtle1999's approval count your points alongside their own. Until they approve, your points do not count, even if your own approval remains active. Each evaluation reconciles every active eligible command: it dismisses the sender's existing `APPROVED` and `CHANGES_REQUESTED` reviews, then requests review from recipients who have neither approved nor already been requested. This also handles commands posted on drafts once the PR becomes ready and commands whose original event was replaced in the concurrency queue. Other requested reviewers remain unchanged. The command does not submit a review; drafts do not dismiss or request reviews. Comment-only and pending reviews cannot be dismissed. A failed dismissal fails the run and prevents review requests; scores are refreshed after successful dismissal. Request failures are logged without changing the decision, and subsequent evaluations retry outstanding requests.

Both accounts must currently have write or admin permission, and neither may be the PR author. Commands involving ineligible accounts are ignored. A sender's newest surviving eligible, author-authorized command wins, in comment creation order; editing an older comment does not move it after newer comments. Submitting any review after delegation automatically takes the points back, including an approval, change request, or comment-only review. Submitting an inline diff comment with “Add single comment” also creates a comment-only review and reclaims the points. Pending reviews do not count; a later dismissal does not restore the delegation. When timestamps are equal, the review takes precedence. A new command after the review can delegate again; editing an older command cannot reactivate it. Post `/delegate @your-own-username` to restore your own review decision. Editing or deleting a command recomputes delegation from remaining comments, so deleting the latest command can restore an older one. Quoted commands, code blocks, review bodies, inline review comments, and commands mixed with other text do not count. Surrounding whitespace is allowed; account matching is case-insensitive. An edited command is accepted only when GitHub identifies the original author as its latest editor; edits by other accounts cannot delegate or cancel that author’s points.

Each sender contributes at most once, using their own fixed weight or production-line ownership. A delegate can receive points from multiple senders, but can transfer only their own points: delegated points are not forwarded through another delegation. Author credit cannot be delegated. Other reviewers' effective `CHANGES_REQUESTED` decisions still block the PR. The sender's old reviews are dismissed through GitHub, so their old change request stops blocking only after dismissal succeeds. That dismissal retains the original submission timestamp and does not cancel delegation; only a review submitted by the sender at or after the command automatically reclaims their points. Dismissing or replacing the delegate's approval removes the counted points but leaves the delegation active for the delegate's next approval. Logs identify each counted score owner and their delegate. Comment history failures or the 3,000-record limit fail evaluation instead of accepting a partial history.

<a id="security"></a>

## Security

All actions in the approval job are pinned to commit SHAs. The job checks out only the repository default branch. It does not check out or execute pull-request code. Its only secret is the dedicated approval App private key; the minted token is scoped to `Contents: write`, `Issues: write`, and `Pull requests: write` for this repository and owns every read and write, including the status comment, the approving review, dismissal, delegation reconciliation, and review requests. Only when there is no blocker, reviewer points plus author credit are insufficient, and an approval has the policy’s default weight, the job fetches complete history, passes Git objects to the trusted classifier as data, and resolves commit authors in batches of 50. Fetch credentials exist only in the Git child environment. Missing history, parsing failures, or incomplete author queries fail evaluation rather than producing a partial score. The review-event workflow has no `GITHUB_TOKEN` permissions and passes only a decimal pull-request number in its run title. The publisher accepts only successful `pull_request_review` runs from the review-event workflow file, identified by `workflow_run.path`; GitHub can populate `workflow_run.name` with the expanded run title. The publisher rejects an invalid run title and a number that does not resolve to the workflow run's current pull-request head. Pull-request reviews and comments are treated as API data and escaped in logs. Every evaluation verifies command authors and latest editors by immutable account ID through GraphQL, matching the body to the REST comment history before counting points or acting. Missing or inconsistent editor metadata fails evaluation. Non-author edits are ignored. Only active eligible delegations are reconciled; superseded or revoked commands have no effects. Dismissal failures fail the run; request failures remain separate from the approval decision.

Approval policy changes take effect only after they merge into the default branch. This prevents an untrusted pull request from changing the program or policy for its own run.

<a id="verification"></a>

## Verification

Run `pnpm run test:approval-policy` for policy parsing, effective review decisions, review-event validation, merged-history pagination and account matching, lazy author credit, permission filtering, weighted scoring, delegation conservation and revocation, editor authorization, comment pagination, dismissal and review-request reconciliation, blockers, drafts, closed-PR skips, status-comment creation and update, comment removal, approving-review submission and deduplication, approval retraction, self-approval exclusion, and API failures. [Workflow tests](../../scripts/ci-workflow.spec.ts) pin the trusted checkout, no-permission review handoff, permissions, App token scopes, events, and commands. The repository gate graph runs the approval policy and workflow tests in CI. The Python SDK job runs `uv run --python 3.10 --with-requirements .github/review-ownership/requirements.txt python -m unittest discover -s .github/review-ownership -p 'test_*.py'` for real Git histories, lexers, renames, shallow-history rejection, and the publisher’s fetch/analysis integration.

<a id="dev-note"></a>

## Dev Note

[archived Production blame weighting](../../.agents/notes/archived/process/2026-09-11-production-blame-approval-weight.md) records the scoring rationale and measured costs.

[archived PR-scoped delegation](../../.agents/notes/archived/process/2026-09-15-pr-approval-delegation.md) records score ownership and revocation choices.

[Weighted approval as an approving review](../../.agents/notes/implemented/process/2026-11-18-weighted-approval-as-review.md) records why the commit status and decision check run were removed.
