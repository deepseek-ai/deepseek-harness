# Agent Note: Weighted approval keeps its commit status gate and adds a decision check run

Status: implemented

English | [中文](2026-10-20-weighted-approval-status-gate-with-check-run-label.zh.md)

## Problem

The `weighted approval` commit status is the record this repository's branch rules require, and below the approval threshold it stays `pending`. A commit status has no action-required state, so readers cannot tell an approval wait from running work. Moving the gate to a check run does not work: after that change, the check run completed as `success` on the pull-request head and both the REST API and `gh pr checks` listed it, while the merge box kept reporting the same `weighted approval decision` context as `Expected — Waiting for status to be reported`, and two pull requests needed an administrator bypass. That change was reverted.

## Decision

The publisher keeps writing the `weighted approval` commit status exactly as before: `pending` while the policy is unmet, `success` when it holds, and `error` when setup or evaluation fails. Branch rules keep requiring that status. That behavior, including keeping an unmet policy `pending`, is what the [archived decision](../../archived/process/2026-09-09-blocked-weighted-approvals-remain-pending.md) records; this change adds the label beside it instead of changing the gate.

The publisher additionally writes a `weighted approval decision` check run for the same evaluation: `action_required` while the policy is unmet, `success` when it holds, and `failure` when setup or evaluation fails. The check run's title carries the score or the blocker. Branch rules do not require it, so it never blocks a merge; it names the blocked state beside the status that does.

A head keeps one GitHub Actions run with the check-run name: the publisher updates the head's existing run and creates one only when none exists. The setup phase creates the run as `in_progress` on a head without one and deals with a published success by rewriting its conclusion to `action_required`, because GitHub accepts but does not apply a return to `in_progress`. A failed check-run write is logged and never changes the status, so a token without the checks permission, or a check-run API failure, leaves the gate as the status wrote it. The publisher identifies its own runs by the `external_id` marker it sets on creation, which excludes check runs that workflow jobs produce for a same-named job. It revokes a published `success` before dependency setup, because GitHub accepts but does not apply a return to `in_progress`.

## Verification

[Approval policy tests](../../../../.github/review-ownership/check-approval.test.mjs) pin the unchanged status states, the check-run conclusion for a met and an unmet policy, the phase writes, revoking a published success through its conclusion, one run per head, and invalid list responses. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the `checks: write` and `statuses: write` permissions and the setup phase commands.

The check-run limit was measured on 2026-10-20 with the reverted attempt on this repository: the `weighted approval decision` check run completed as `success` on the pull-request head, the REST API and `gh pr checks` listed it, and the merge box kept reporting the same context as expected.

## Alternatives considered

**Require the check run instead of the commit status.** Measured above: the ruleset does not match a check run published through the default-branch workflow's token, so the gate cannot be satisfied.

**Publish the commit status as `failure` while the policy is unmet.** The status would complete, but this changes the required record's meaning and would report an unmet, reversible condition as a malfunction.

**Publish only the check run and leave the status untouched.** The status would keep its last state from an earlier evaluation, so the gate and the label could disagree.

**Publish the required check run from a dedicated GitHub App.** A check run whose app the ruleset names would let the required entry carry the action-required conclusion itself. The repository has no App with the checks permission; with one, the label could move onto the required record and the status could be retired.

## Consequences

A job that ends between the `pending` write and the fallback step, such as a lost runner or a cancellation that skips the final step, leaves the status `pending`; that is the original symptom of this status, not a regression from the added label. While reviewers are pending, the merge box reports `weighted approval` as pending (the gate) and the `weighted approval decision` entry as `action_required`, with the score or blocker in its title; `gh pr checks` lists both. A published success is revoked by rewriting the check run's conclusion, and the status follows the unchanged policy states.
