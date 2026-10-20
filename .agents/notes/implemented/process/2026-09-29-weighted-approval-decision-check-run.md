# Agent Note: Weighted approval decisions are completed check runs

Status: implemented

English | [中文](2026-09-29-weighted-approval-decision-check-run.zh.md)

## Problem

The weighted approval policy must block merging until its conditions hold, distinguish an unmet condition from a failed evaluation, and let tools that wait for pull-request checks to finish terminate. A draft pull request, insufficient approval points, and an effective `CHANGES_REQUESTED` review from a write-capable reviewer are reversible review states rather than evaluation failures.

Commit statuses offer only `pending`, `success`, `failure`, and `error`. A `pending` commit status blocks merging, but `gh pr checks --watch` and other CI watchers treat it as running work and wait until someone approves. A `failure` commit status ends the wait but reports an unmet, reversible condition as a malfunction and conflates the policy outcome with publisher health.

## Decision

The [publisher](../../../../.github/review-ownership/check-approval.mjs) reports the decision as the `weighted approval decision` check run on the pull-request head, written with the job's GitHub Actions token. Branch rules require that check run with GitHub Actions as its expected source.

| Condition | Check run |
|---|---|
| First evaluation of a head | `in_progress` until the decision is written |
| Re-evaluating a head that published `success` | conclusion `action_required` until the decision is written |
| Draft, fewer than the required points, or an effective write-capable `CHANGES_REQUESTED` review | `completed`, conclusion `action_required` |
| Ready, threshold met, and no blocking review | `completed`, conclusion `success` |
| Setup, evaluation, or cancellation failure | `completed`, conclusion `failure` |

A check run that reached `completed` never returns to `in_progress` or `queued`: GitHub answers `200` to that update and leaves the run completed, so only the conclusion is mutable. The publisher therefore revokes a published success by writing the blocking conclusion before dependency setup, which covers the setup and history fetch that dominate a cold evaluation. The head keeps one GitHub Actions run with the required name: the publisher updates the head's existing run and creates one only when none exists. An incomplete list or a run without a valid ID fails the publication. The publish step records the conclusion it wrote in a step output, and the setup-failure step runs only when no conclusion was recorded: a published decision survives a later failure or cancellation, while a run cancelled before that write concludes `failure`. A run cancelled before the publish step records its conclusion, including a cancellation whose file-command outputs the runner drops, therefore concludes `failure`, which still blocks the merge. During a re-evaluation, a previous decision other than a published success keeps its conclusion and title until the new decision is written; a published success is replaced by `action_required` and the preparation title.

A blocking review dominates the point total, so the conclusion remains `action_required` even when counted approvals reach the threshold. GitHub accepts only `success`, `neutral`, and `skipped` for a required check, so `action_required` blocks merging while completing the check.

## Verification

[Approval policy tests](../../../../.github/review-ownership/check-approval.test.mjs) pin the threshold-reaching blocker case, the exact published check-run payloads, revoking a published success through its conclusion, updating an existing run instead of creating another, recording the conclusion that the setup-failure step reads, and invalid list responses. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the `checks: write` permission, the `revoke` and `failure` phase commands, the publish step identity, and the fallback that runs when a run fails or is cancelled before publishing.

The transition matrix and the fallback condition were measured on 2026-09-30 with throwaway tag runs in this repository, using the same GitHub Actions token as the publisher. A run created as `in_progress` and completed as `success` accepted `status: in_progress` and `status: queued` with `200` and stayed `completed`, while conclusion-only updates moved it to `action_required`, back to `success`, and to `failure`. Those runs measured the fallback condition as it stood on 2026-09-30 (`failure() || (cancelled() && steps.publish.outcome != 'success')`): the step ran for a failed publish and for a cancellation during the publish step, and did not run when the job was cancelled after the decision was published. The current condition also requires an empty `concluded` output, so a job cancelled after the publish step recorded its conclusion skips the fallback in either condition. A `timeout-minutes` cancellation was measured separately on 2026-10-20: a job that exceeded its one-minute timeout on a throwaway `push` branch still ran its `cancelled()` step, so the step executes on that path; whether a cancelled step's file-command outputs are exposed was not measured, and dropping them only makes that cancellation conclude `failure`.

The list response's `total_count` counts the `check_name`-filtered runs rather than every check on the head: on 2026-10-20 a head carrying 33 check runs reported `total_count` 0 for a name that matches none and 2 for an existing name, so an equality between `total_count` and the returned array length rejects a truncated page.

## Alternatives considered

**Keep the `pending` commit status.** Branch rules block correctly, but CI watchers cannot distinguish an approval wait from running checks and do not finish.

**Publish `failure` for unmet conditions.** This ends the wait, but it represents an unmet, reversible merge condition as a malfunction and conflates the policy outcome with publisher health.

**Revoke by returning the completed run to `in_progress`.** GitHub accepts that update without applying it, so the published success would stand through dependency setup and the history fetch.

**Publish nothing until success.** A required check that was never reported remains expected and is invisible to many watchers. Revoking a success already published on the same head still requires a non-success write, and each watcher's treatment of a missing required check is unspecified.

**Keep the `weighted approval` name.** When a check and a commit status share a required name, GitHub requires both to pass. Heads that carry a `pending` commit status from the earlier publisher would stay blocked until a new push.

**Create a new check run on every evaluation.** Several same-name check runs on one head make the result depend on how GitHub and each watcher select among them.

**Let approval points override a blocking review.** This makes the score the only success condition, but it permits success while a write-capable reviewer's effective decision still requests changes.

## Consequences

CI watchers finish while the decision waits on reviewers. `gh pr checks` groups `action_required` with failed checks and exits non-zero; consumers distinguish it by the check name, the `ACTION_REQUIRED` conclusion, or the output title, which carries the score or blocker. The `weighted approval publisher` Actions job and the `failure` conclusion carry operational failures.

Re-evaluating a head that already published `success` reports `action_required` until the new decision is written, so a watcher that polls inside that window sees a failed check.

The branch-rule switch leaves two gaps on heads the publisher has not evaluated since it. A check run's name does not identify its publisher. Any workflow in the pushed branch can name a job `weighted approval decision`: on 2026-10-20 a job with `if: false` on a throwaway branch produced a `github-actions` check run with that name and conclusion `skipped` on the pushed commit, and a required check accepts `skipped`. The publisher therefore revokes every passing conclusion it finds before dependency setup and adopts every same-named run when it publishes, which covers a run that exists at either write; a same-named passing run created after the publisher's last write on the head is outside its control. Requiring the check from a dedicated GitHub App is the only complete binding, and it replaces the job token with an app-installed identity.

A head without the decision check run reports the required check as expected until the next publisher event creates it; re-running a pre-switch run does not, because a re-run replays that run's earlier workflow file, which calls the removed `pending` phase against the new script. A re-run of a pre-switch run on 2026-10-20 executed the pre-switch step names and no check-run write. A pull-request edit triggers the publisher's `edited` event, so the rollout can create the run on a head that has none. A head that also carries the earlier `weighted approval` commit status keeps that pending status until the same event: the combined status resolves each context to its latest status, so the rollout posts a terminal `success` status for that context on every open head instead of waiting for its next push.
