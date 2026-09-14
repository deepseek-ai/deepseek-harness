# Pull-request approval policy

## Summary

The [`weighted-approval` workflow](../workflows/weighted-approval.yml) publishes an approval score for branch rules. Reviewer selection and review requests remain manual.

## Table of Contents

- [Approval scoring](#approval-scoring)
- [Security](#security)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="approval-scoring"></a>

## Approval scoring

The weighted approval workflow exposes two pull-request checks. The `weighted approval publisher` Actions job reports whether evaluation and status publication completed, while the `weighted approval` commit status carries the approval decision on the pull request head. Branch rules must require only the commit status with GitHub Actions as its expected source; a context-only requirement can accept a same-named status from another integration. A completed evaluation returns `pending` below two approval points, while the pull request is a draft, or while a write-capable reviewer has an effective `CHANGES_REQUESTED` review; the blocker keeps the status pending even when counted approvals reach the threshold. It returns `success` only when the threshold is met, the pull request is ready, and no such blocker exists. If evaluation fails, the publisher writes an `error` status.

Reviewers whose calculated base repository permission is `write` or `admin` count. The [approval policy](approval-policy.json) gives `@07akioni`, `@imccyu`, `@tianyicui`, `@tianyicui-bot`, `@turtle1999`, and `@turtle2099` two points each; every other write-capable reviewer gets one point. The pull-request author and reviewers without write permission do not count.

Each reviewer contributes only the current `APPROVED` or `CHANGES_REQUESTED` decision that GitHub returns. A `DISMISSED` record clears that reviewer's standing decision, including earlier approvals. Comment-only and pending records do not replace a decision. Reviews from deleted accounts and reviewers without current repository access do not count. The workflow does not invalidate an approval by its review commit; the repository's native pull-request rules own stale-review and latest-push requirements.

The publisher runs when a pull request opens, synchronizes, reopens, becomes ready, or becomes a draft. Review submissions, edits, and dismissals run the no-permission [`weighted-approval-review-event` workflow](../workflows/weighted-approval-review-event.yml); its validated run title supplies the pull-request number to the default-branch publisher. The publisher validates the current head, fetches every review, and resolves current repository permission before publishing the status. Permission changes take effect on the next subscribed pull-request or review event.

<a id="security"></a>

## Security

The status-writing job checks out only the repository default branch. It does not check out or execute pull-request code and does not use repository secrets. The review-event workflow has no `GITHUB_TOKEN` permissions and passes only a decimal pull-request number in its run title. The publisher accepts only successful `pull_request_review` runs from the review-event workflow file, identified by `workflow_run.path`; GitHub can populate `workflow_run.name` with the expanded run title. The publisher rejects an invalid run title and a number that does not resolve to the workflow run's current pull-request head. Pull-request reviews are treated as API data and escaped in logs.

Approval policy changes take effect only after they merge into the default branch. This prevents an untrusted pull request from changing the program or policy for its own run.

<a id="verification"></a>

## Verification

Run `pnpm run test:approval-policy` for policy parsing, effective review decisions, review-event validation, pagination, permission filtering, weighted scoring, blockers, drafts, status publication, and API failures. [Workflow tests](../../scripts/ci-workflow.spec.ts) pin the trusted checkout, no-permission review handoff, permissions, events, and commands. The repository gate graph runs the approval policy and workflow tests in CI.

<a id="dev-note"></a>

## Dev Note

None.
