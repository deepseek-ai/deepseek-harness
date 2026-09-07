# Agent Note: Session content search ships opt-in through openAt never

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-13-session-content-search-opt-in.zh.md)

## Problem

The shipped bundles mounted the SQLite session-query provider with the full-text index live (`openAt: first-search`), so every default deployment carried a derived FTS index and the Web sidebar offered content search. Whether a deployment wants that index — its node:sqlite import, per-search source reconciliation, and derived storage — is a deployment choice, and the product default is to ship without it; the model-facing search tools were already opt-in and unmounted (the [not-shipped-default decision](../feature/2026-08-02-session-search-not-shipped-default.md)).

Turning the capability off by unmounting the plugin row is not viable. `ApiProxyService` declares `sessionQuery` as a required injection, so without the provider the whole host API gateway stays unloaded and the Web GUI never boots. Session-log export traces subagent descendants through `ctx.sessionQuery.traceSession`, and a subagent fork resolves its Workspace through the same lineage trace — both would need optional-service guards plus a replacement lineage source, roughly tripling the change surface while losing exact reads everywhere.

## Decision

Content search is enforced off at the provider. `openAt: 'never'` is a third opening phase on `@deepseek-ai/dsh-session-query-sqlite`: `searchSessions` and `searchEvents` fail with the typed `SESSION_QUERY_SEARCH_DISABLED` code before any request normalization, node:sqlite is never imported or opened, and no source observation or reconciliation runs. Every inherited `ctx.sessionQuery` exact read, filter, and trace keeps working, so session export, fork Workspace inheritance, and title reads are unaffected.

`SESSION_QUERY_SEARCH_DISABLED` joins the closed `SessionQueryErrorCode` taxonomy, and the `tool-session-query` service boundary maps it to the model-safe message `session search is disabled in this deployment`.

The base bundle sets `openAt: never` on the `session-query-sqlite` row and the web bundle's restatement keeps it; enabling content search is a one-line `openAt` override (`first-search` or `startup`) in a later patch layer, typically with a durable `path`. The host `session.search` endpoint reports the provider failure through its existing error path, and the Web sidebar keeps its designed degradation: local title/workspace matching plus the content-search-unavailable notice. The CLI compat spec pins the shipped `openAt: never` rows, while the web e2e scaffold keeps content search enabled — its seeded-session scenarios navigate by content search, and those runs are the assembled coverage for the opt-in path.

## Alternatives considered

- **Unmount the plugin row** (`disabled: true` in the base patch): rejected — the api-gateway's required `sessionQuery` injection keeps the whole host API unloaded, and making that injection optional forces guards plus a header-walk lineage fallback in session export and fork resolution.
- **Disable at the consumers** (the host `session.search` endpoint or the sidebar): rejected — enforcement belongs to the operation that makes the decision; opt-in model tools or any other consumer would still reach the index.
- **A separate boolean beside `openAt`**: rejected — the opening phase already owns when SQLite starts; `never` extends the same axis instead of adding a second knob that can contradict it.

## Consequences

- Default deployments run no derived index: no node:sqlite import or experimental-SQLite startup warning, no reconciliation work, no derived database on disk. Sidebar search matches session titles and workspace names only.
- Search failures under the default are typed and stable rather than incidental, so callers distinguish a deployment choice from an index fault (`SESSION_QUERY_INDEX_FAILED`).
- Re-enabling content search is per-deployment configuration, not a code change, and restores the full FTS behavior unchanged.
- Compositions that mount the search tools without overriding `openAt` get the model-safe disabled message on every search call; enabling the tools implies enabling the index.
