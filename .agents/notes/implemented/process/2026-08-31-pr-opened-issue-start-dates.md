# Agent Note: PR-opened Issue start dates

Status: implemented

English | [中文](2026-08-31-pr-opened-issue-start-dates.zh.md)

## Problem

The Issue Project records planned work in a `Start date` field, but adding or linking an Issue does not provide a date value. A pull request can identify both Issues it resolves and Issues that supply related implementation context, and either relationship marks the start of repository work.

Updating the field on every pull-request event would assign dates to existing work after edits, pushes, or reopenings. Replacing an existing date would also discard a manually planned date or a date recorded by an earlier pull request.

## Decision

The Issue lifecycle workflow initializes `Start date` only for `pull_request.opened`. It reads the pull request's live body, retains every same-repository reference that resolves to an Issue, converts `created_at` to a calendar date in the configured Project time zone, ensures the Issue is a Project item, and writes the configured Date field only when the current value is empty.

The configuration names the Project field and time zone. Missing configuration fails when the policy module loads; a missing field, a non-Date field, an invalid timestamp, or a failed API request fails the workflow at the first relevant pull request.

[Event-directed PR review status commands](2026-08-10-event-directed-pr-review-status.md) continue to own Status transitions. Date initialization includes resolving and informational Issue references, runs for Draft and automated pull requests, and does not depend on PR policy enforcement.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) cover the Shanghai date boundary, opened-only dispatch, all retained Issue references, empty-value writes, existing-value preservation, missing Project items, invalid field configuration, and the GraphQL mutation variables. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) require the `pull_request.opened` subscription.

## Alternatives considered

**Use a built-in Project workflow.** The built-in workflows own fixed Project item and Status transitions; the repository workflow already owns authenticated GraphQL mutations and can supply the PR creation date.

**Process every subscribed PR event or run a reconciler.** Later events would fill dates for existing pull requests and references added after creation, but they would make the field a repair projection instead of a record created with the pull request and would add repeated Project reads.

**Update only resolving Issue references.** Informational references also identify Issues whose implementation work begins with the pull request, so the date initializer uses the existing all-reference set while Status transitions retain resolving-only semantics.

**Overwrite an existing date.** A later pull request must not replace a manual plan or the date written for earlier work, so the mutation follows an empty-value read.

## Consequences

Only pull requests opened after the workflow ships initialize dates. References added after creation and existing open pull requests remain unchanged, and the workflow does not scan existing Project items or pull requests.

The empty-value read makes retries idempotent in ordinary operation. ProjectV2 has no conditional field update, so simultaneous pull requests that reference the same empty Issue can both write; per-PR concurrency does not serialize that Issue, and the last mutation can win.
