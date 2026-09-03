# Agent Note: Project-local Issue planning fields

Status: implemented

English | [中文](2026-09-02-project-local-issue-planning-fields.zh.md)

## Problem

The Issue lifecycle workflow needs structured planning metadata, but organization Issue fields require a separate GitHub App permission from organization Projects. A workflow token with Project write access can read and update Project custom fields while GitHub rejects Issue-field reads, so using both storage systems makes one policy depend on two independently administered permission sets.

Priority, impact, cost, and dates are used to plan work in `DSH Issue Management`. Keeping those values on the Issue also exposes them outside that Project, but the repository has no workflow that needs cross-Project values.

## Decision

The `DSH Issue Management` Project owns `Priority`, `Severity`, `Cost`, `Start Date`, and `Target Date` as Project custom fields. `Severity` uses the option meanings from the organization `影响面` field, and `Cost` uses the option meanings from `解决代价`.

Repository policy resolves `Priority` and `Start Date` from the configured Project. It rejects an Issue-backed field or the wrong data type, reads Priority from the Project item, and writes Start Date through `updateProjectV2ItemFieldValue`. Organization Issue fields are retained only as `Legacy ...` migration sources and are not read by repository workflows.

The pull-request policy workflow uses the repository `GITHUB_TOKEN` for REST Issue and pull-request reads, and a GitHub App token restricted to repository Issues and organization Projects read access for ProjectV2 queries. Lifecycle mutations continue to use the write-capable App token.

The Issue lifecycle workflow initializes `Start Date` only for `pull_request.opened`. It reads the pull request's live body, retains every same-repository reference that resolves to an Issue, converts `created_at` to a calendar date in the configured Project time zone, ensures the Issue is a Project item, and writes the date only when the current Project value is empty.

The [organization-field implementation](../../archived/process/2026-08-31-pr-opened-issue-start-dates.md) records the superseded cross-Project ownership decision and its event-timing rationale. Event-directed Status transitions remain owned by [the lifecycle decision](2026-08-10-event-directed-pr-review-status.md).

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) require Project custom fields for Priority and Start Date, prove repository and Project reads use separate credentials, cover the Shanghai date boundary, opened-only dispatch, empty-value writes, existing-value preservation, and missing Project items, and pin `updateProjectV2ItemFieldValue`. Workflow tests pin the Project token's read-only permission. Removing an organization field requires comparing every legacy value with its Project value, including archived Project items.

## Alternatives considered

**Keep organization Issue fields.** They make one value visible across Projects, but the workflow does not need that scope and the GitHub App would require separate organization Issue Fields access.

**Dual-write Issue and Project fields.** Mirrored fields retain cross-Project visibility, but every writer and manual edit can create drift and requires a reconciliation policy.

**Process every subscribed pull-request event or overwrite Start Date.** Later events could repair missing dates, but they would assign dates after work starts or replace a manual plan. The initializer therefore retains opened-only, empty-only behavior.

## Consequences

Planning metadata is scoped to one Project membership. The same Issue can have different values in another Project, and an Issue outside `DSH Issue Management` has no Project-local planning values.

The GitHub App needs Project access rather than organization Issue Fields access for policy metadata. Field renames or type changes fail the workflow instead of falling back to legacy fields.

The empty-value read makes ordinary retries idempotent. Project field updates have no compare-and-set precondition, so simultaneous pull requests can both observe an empty Start Date and the last mutation can win.
