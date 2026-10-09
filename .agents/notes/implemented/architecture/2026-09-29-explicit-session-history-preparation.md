# Agent Note: Open the Session when migration is required

Status: implemented

English | [中文](2026-09-29-explicit-session-history-preparation.zh.md)

## Problem

Expanding a subagent catalog or forking from the sidebar can trigger an old Session's format migration.

## Decision

The WorkspaceBrowser row-menu fork request carries `allowMigration: false`, which the Host handles by checking `stat` format information before calling the original fork flow. Only a source format requiring migration is refused, with an app-wide Toast offering to open the original Session. That action only navigates and does not retry fork. Neither an absent live Session nor unopened Client history justifies refusal.

Other fork callers omit that option and allow automatic migration.

`session.projections` also checks the stored format first; current-format cold history still uses the original observation flow for exact projections. Success returns `kind: sequenced` and its real `asOfSeq`; required migration returns `kind: migration-required` hints. The Client retains that read state, and cached values cannot replace sequenced values published by history or control.

The `formatStatus` returned by `stat` carries the migration library's existing classification; `header` remains the current logical format. It describes the stored format, not migration-task progress or prepared in-memory history.

When migration is required and `subagentCatalog` is absent, Web marks the Session's row “Migration required” and keeps its history-opening actions without descendant expansion or changing its subagent mode. Opening the Session supplies its catalog through history and control projections. Available catalogs remain usable, including empty catalogs. Session-list lineage resolves navigation addresses, not missing catalog membership. Ordinary loading, cancellation, and storage errors do not become this migration branch.

Create/adopt, full-text search, and ordinary history opening allow automatic migration.

This decision adds a migration exception to [catalog projection reads](../../archived/simplification/2026-09-08-web-subagent-catalog-projections.md). Exact reads and leases in [Session observations](2026-08-25-session-observations-and-projection-owned-client-state.md), and identity checks and cached/sequenced ordering in [projection-cache reads](2026-09-19-projection-cache-listing-identity-and-cached-rows.md), still apply.

## Alternatives considered

**Treat every cold Session as needing migration.** Residency and stored format are different; this would reject otherwise valid forks and discard catalog information available on disk.

**Globally forbid forks that automatically migrate on the Host.** The sidebar's interaction choice does not govern other callers, so its request explicitly carries the restriction.

**Automatically open and retry the sidebar fork.** Opening is an explicit user action, and fork does not run automatically after migration.

**Derive catalogs from Session-list parent ids.** This adds a second membership derivation; explicit Session opening obtains the catalog.

**Give cached hints `asOfSeq: -1`.** Hints have no event cut in current history and cannot participate in sequence comparisons.

## Consequences

Sessions requiring migration use the existing opening flow to prepare history; Sessions that need no migration remain cold-readable and forkable. Catalog hints may lag the log and yield to subsequent exact projections.

A separate follow-redirection proposal discusses future single-Session migration progress; this decision does not implement that flow.
