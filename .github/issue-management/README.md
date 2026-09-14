---
description: "Issue policy enforcement, Project access, and lifecycle events for repository maintainers."
---

# Issue management

English | [中文](README.zh.md)

## Summary

Contributors can link Issues as context without coupling pull-request validation to Project availability. Resolving references additionally enforce Project Priority. The required `Issue policy` job and the separate lifecycle workflow use trusted default-branch code.

## Table of Contents

- [Pull-request policy](#pull-request-policy)
- [Lifecycle events](#lifecycle-events)
- [Configuration and limitations](#configuration-and-limitations)
- [Module ownership](#module-ownership)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="pull-request-policy"></a>
## Pull-request policy

[Issue policy](../workflows/issue-policy.yml) applies to non-draft, human-authored PRs with a requested review or submitted review. Exempt PRs finish successfully without resolving Issue references, minting a Project App token, or querying ProjectV2. Eligibility uses live repository state before expensive reads; the required job remains present for subscribed events. Final validation re-reads live state: preflight is not a cached verdict or an exemption for metadata edits.

Selective preflight requires [selective-preflight.json](selective-preflight.json) in the trusted checkout. Without that marker, the workflow preserves legacy behavior: human PRs receive a Project token and full legacy validation; Bot/App PRs skip both. A failed supported preflight fails the job rather than falling back.

Eligible PRs need at least one same-repository Issue reference, exactly one canonical `kind/*`, at least one `area/*`, and at most one `p0`–`p3` label. Unsupported kinds, retired aliases, and `source/*` labels fail validation; [label taxonomy](../../.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md) owns their meanings.

- Informational references, such as `Refs #3624`, establish context. Validation uses REST to distinguish Issues from PR numbers and does not read their Project fields. An informational-only PR can carry its own Priority without matching the referenced Issue.
- Resolving references use closing keywords such as `Fixes #123`, `Closes #123`, or `Resolves #123`. Only references that resolve to actual Issues require Project reads during validation. A PR Priority must match the highest resolving-Issue Priority; a resolving PR with a Priority label requires every resolving Issue to have Priority. If all resolving Priorities are empty, the PR may omit Priority.
- References inside HTML comments, code fences, or inline code do not count. Cross-repository references and references to PRs do not satisfy the Issue requirement.

REST reads use the repository `GITHUB_TOKEN`. Project validation uses a separate App token with Issues and organization Projects read permissions. Missing required Project access or invalid field configuration fails validation rather than bypassing resolving-Issue Priority checks.

-----

<a id="lifecycle-events"></a>
## Lifecycle events

[Issue lifecycle](../workflows/issue-lifecycle.yml) mutates Project data independently of PR validation eligibility. PR opened/reopened events and body edits can advance resolving Issues to `In progress`; title-only edits do not. Review requests target `In review`. Changes-requested reviews target `In progress`, with the [human-ownership and terminal-status protections](../../.agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.md).

Approval-only and comment-only reviews do not allocate a lifecycle runner. PR pushes and label changes, and Issue assignment changes, do not trigger lifecycle work. Other subscribed Issue events maintain membership, state, and audit comments; exact subscriptions live in the workflow.

PR opening initializes an empty Project `Start Date` for every referenced Issue, including informational references, using the PR creation date in the configured time zone. This lifecycle operation can add Project membership and needs Project write access; the informational-reference read exemption applies only to PR validation. [Planning-field ownership](../../.agents/notes/implemented/process/2026-09-02-project-local-issue-planning-fields.md) defines date preservation.

-----

<a id="configuration-and-limitations"></a>
## Configuration and limitations

[config.json](config.json) selects the repository, Project, field names, statuses, lifecycle actor, and time zone. The policy reads the Project custom single-select `Priority` field, not a native organization Issue Priority field. Maintainers set Project Priority manually; skill guidance that directs edits to native Issue fields does not populate this value. Issue audits remove PR-only kinds and retired label aliases before validating the remaining metadata. There is no field migration or Priority synchronization.

Lifecycle processing is event-driven, not a reconciler. Omitted events do not repair Project state, and concurrent Project mutations have no atomic compare-and-swap. Selective evaluation does not redesign required-check authority or guarantee measured Actions-minute savings. The [selective-evaluation decision](../../.agents/notes/implemented/process/2026-09-07-selective-issue-policy-evaluation.md) records the trade-offs.

-----

<a id="module-ownership"></a>
## Module ownership

Maintainers reuse the owning module directly; [policy.mjs](policy.mjs) only reads the event file, dispatches commands, and reports command failures. The [module-ownership decision](../../.agents/notes/implemented/process/2026-09-07-issue-policy-module-ownership.md) explains this separation.

<details>
<summary>Implementation owners</summary>

[rules.mjs](rules.mjs) owns pure validation, reference parsing, status decisions, and date conversion. [github.mjs](github.mjs) owns credential selection, REST/GraphQL transport, Issue/Project reads, and Project membership and field writes.

[pull-request.mjs](pull-request.mjs) assembles read-only PR snapshots and runs policy preflight and validation, including their workflow outputs. [lifecycle.mjs](lifecycle.mjs) reuses the PR reference reader and shared rules to coordinate Project mutations, Issue label repairs, and audit comments. Snapshot readers do not mutate GitHub; the shared transport also supports writes, so importing it does not restrict a caller's permissions.

</details>

-----

<a id="verification"></a>
## Verification

The focused, keyless policy suite runs from the repository root:

```sh
node --test .github/issue-management/policy.test.mjs
```

[Workflow tests](../../scripts/ci-workflow.spec.ts) verify trigger and permission declarations. Local tests do not establish live GitHub delivery, App installation access, or actual runner cost; repository maintainers verify those in Actions.

-----

<a id="dev-note"></a>
## Dev Note

None.
