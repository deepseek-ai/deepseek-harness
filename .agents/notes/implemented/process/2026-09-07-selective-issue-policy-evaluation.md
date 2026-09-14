# Agent Note: Selective Issue policy evaluation

Status: implemented

English | [中文](2026-09-07-selective-issue-policy-evaluation.zh.md)

## Problem

Informational Issue references provide context, while resolving references carry a Priority obligation. Requiring Project access for both makes unrelated board configuration or App availability block context-only PRs. Looking up referenced Issues before determining enforcement eligibility also spends credentials and API requests on PRs that cannot fail policy.

Lifecycle events have a separate cost: an approval, comment, push, label change, or assignment change need not perform a Project status handoff. Allocating a runner for a known no-op consumes capacity without changing the Issue.

## Decision

[Issue policy](../../../../.github/workflows/issue-policy.yml) keeps its required job and trusted default-branch implementation. Enforcement eligibility precedes reference reads and Project App token creation: draft PRs, Bot/App authors, and human PRs with neither review requests nor submitted reviews do not require policy validation.

The workflow checks the trusted checkout for a selective-preflight capability marker before invoking the command. A checkout without the marker uses full legacy validation for human PRs and preserves the legacy Bot/App exemption. This supports PR workflow YAML running against default-branch code that lacks preflight; execution errors never select the fallback.

Eligible PRs resolve references through repository REST reads. Informational references prove Issue identity without Project access. Only actual Issues named by resolving references require Project Priority reads; a PR number cannot satisfy the Issue requirement or cause a Project query. [The owner reference](../../../../.github/issue-management/README.md) defines metadata validation and failure behavior.

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) subscribes to status-relevant PR events and filters title-only edits. It does not subscribe to PR pushes or label changes, or Issue assignment changes. Its job condition rejects approved/commented reviews before runner allocation. Changes-requested reviews retain their status command.

This scheduling decision partially supersedes the no-op-job scheduling in [event-directed review status](2026-08-10-event-directed-pr-review-status.md), not its handoff semantics or human-ownership protection. [Project-local planning fields](2026-09-02-project-local-issue-planning-fields.md) still own opened-only, empty-only Start Date initialization for every referenced Issue, including informational references. The validation read exemption does not exempt that lifecycle mutation.

## Alternatives considered

**Read every referenced Issue's Project fields.** Informational references do not constrain Priority, so these queries add failure dependencies without contributing a validation result.

**Keep successful no-op lifecycle jobs for approvals and comments.** That preserves a green job presentation but allocates a runner for an event with no lifecycle command. Lifecycle is separate from the retained required policy job.

**Remove the required policy job or redesign check authority.** Selective reads and lifecycle scheduling can reduce avoidable work without changing which required check GitHub expects. Check-authority redesign is not part of this decision.

## Consequences

Informational-only validation needs repository access but not Project credentials. Resolving validation still fails when required Project reads or field checks fail. Preflight and final validation each read live REST state, duplicating repository requests rather than caching a verdict. Avoiding Project reads and token creation does not guarantee fewer total API requests. The required policy job still allocates a runner; this is not a zero-cost required check.

Maintainers manually manage the Project custom Priority field. Native Issue-field skill guidance does not update that value. There is no Priority synchronization, field migration, or change to [presentation-neutral policy](2026-09-03-semantic-issue-templates-and-policy.md).

Omitted lifecycle events cannot repair stale Project state. Event replay and concurrent writes retain the races documented by the lifecycle and planning-field owners. Actual Actions-minute savings and live GitHub App access require operational observation, not inference from a mocked API test.

## Verification

[Policy tests](../../../../.github/issue-management/policy.test.mjs) verify early exemptions, REST-only informational references, actual-Issue filtering, resolving Priority reads and failures, and the lifecycle command selection. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) verify Project-token conditions, the retained required job, pruned subscriptions, and runner-level lifecycle filtering. Local fixtures do not establish live webhook delivery or billing outcomes.
