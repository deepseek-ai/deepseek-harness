# Agent Note: Identify approval review workflows by file path

Status: implemented

English | [中文](2026-09-10-approval-review-workflow-identity.zh.md)

## Problem

GitHub can populate a workflow run's `name` with its expanded `run-name`. The approval review workflow includes the pull-request number in that title, so comparing `workflow_run.name` with the static workflow name rejects valid review events before refreshing the approval status.

## Decision

The [approval publisher](../../../../.github/review-ownership/check-approval.mjs) identifies the review-event workflow by its exact `workflow_run.path`. It also requires a successful `pull_request_review` run, parses the pull-request number from `display_title`, validates any supplied pull-request association, and compares the current pull-request head with the reviewed head before evaluating approvals.

## Alternatives considered

**Accept a name prefix.** A display name does not identify the workflow file; another workflow can use the same title.

**Remove the numbered run title.** The title supplies the pull-request number when GitHub returns an empty `pull_requests` array. Removing it requires a different handoff mechanism.

## Consequences

Run-title expansion does not prevent approval refreshes, while an unexpected workflow file still fails validation. Moving the review-event workflow requires updating the publisher's expected path.

[Approval policy tests](../../../../.github/review-ownership/check-approval.test.mjs) cover a numbered run name, invalid source paths and events, unsuccessful runs, invalid titles, and superseded heads. The [approval outcome policy](2026-09-09-blocked-weighted-approvals-remain-pending.md) continues to own pending and successful status semantics.
