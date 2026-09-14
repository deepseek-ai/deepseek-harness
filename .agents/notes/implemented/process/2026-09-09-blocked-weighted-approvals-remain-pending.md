# Agent Note: Blocked weighted approvals remain pending

Status: implemented

English | [中文](2026-09-09-blocked-weighted-approvals-remain-pending.zh.md)

## Problem

The weighted approval commit status must distinguish an unmet merge condition from a failed policy evaluation. An effective `CHANGES_REQUESTED` review from a write-capable reviewer prevents a pull request from satisfying the approval policy, but it is a reversible review state rather than an evaluation failure.

Publishing `failure` for that review state conflates the approval decision with the health of the publisher. It also treats one unmet policy condition differently from a draft pull request or insufficient approval points, which remain pending while contributors can resolve them.

## Decision

A completed weighted approval evaluation publishes `pending` when the pull request is a draft, has fewer than the required approval points, or has an effective `CHANGES_REQUESTED` review from a write-capable reviewer. A blocking review dominates the point total, so the status remains pending even when counted approvals reach the threshold.

The evaluation publishes `success` only when the pull request is ready, the point threshold is met, and no blocking review exists. The separate `weighted approval publisher` Actions job reports whether evaluation and status publication completed. An evaluation failure publishes an `error` commit status and fails that job.

## Verification

[Approval policy tests](../../../../.github/review-ownership/check-approval.test.mjs) pin the threshold-reaching blocker case and the exact published `pending` payload. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the separate publisher job name.

## Alternatives considered

**Publish `failure` for a blocking review.** This keeps a visibly failed status until the review changes, but it represents an unmet and reversible merge condition as a malfunction and conflates policy outcome with publisher health.

**Let approval points override a blocking review.** This makes the score the only success condition, but it permits a successful status while a write-capable reviewer's effective decision still requests changes.

## Consequences

Required-status branch rules block a pull request because `pending` does not satisfy the required status. Contributors can distinguish review work that remains from a failed approval evaluation, while the publisher job and `error` status retain the operational failure signal.

Consumers do not receive a failed commit status solely because a blocking review exists. They must inspect the status description or effective reviews when they need to distinguish a blocker from other pending approval conditions.
