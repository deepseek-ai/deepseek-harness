# Agent Note: Workspace New Session reuse hijacked cwd-matching unaccounted blank sessions

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-workspace-blank-session-reuse-membership.zh.md)

## Problem

Clicking the `+` on a Workspace group in the sidebar sometimes opened a session that the sidebar showed under Ungrouped instead of under the clicked Workspace — "entered a new session but the Workspace was not selected". The failure was specific to Workspaces registered at the directory the CLI runs from (in practice the harness checkout itself, i.e. `defaults.cwd = process.cwd()`), and appeared once a CLI-born blank session existed there.

Root cause: `connectWorkspace`'s blank-session reuse scanned the session list mirror on `cwd` equality alone. The host's own membership rule requires **both** an id in the Workspace account (`sessionIds`) **and** a session header whose canonical cwd equals the Workspace path ([Workspace UI product flow](../feature/2026-07-25-workspace-ui-product-flow.md)); a cwd match without the account slot is exactly the Ungrouped case. The reuse scan ignored the account slot, so any **live blank** session whose cwd matched qualified — including `main-session-*` sessions the CLI/TUI/headless entry points birth at the host cwd (`session.create({})` falls back to `defaults.cwd` and never attaches to a Workspace). When such a session was live and blank (no `turn/start` yet), the next `+` click on a Workspace registered at that path reused it and navigation opened a session no grouping surface can show under that Workspace. Workspaces at other paths were unaffected because no unaccounted blank sessions accumulate there; the host-cwd Workspace accumulated one per CLI run.

## Decision

The reuse scan now requires workspace membership: `blank` AND `summary.cwd === workspace.path` AND `workspace.sessionIds.includes(summary.id)` AND not archived. A cwd-only match falls through to `session.create({ workspaceId })`, which attaches the fresh session so the Workspace owns it — the same arm the flow already used for "no blank session exists".

## Alternatives considered

**Adopt the stray instead of minting.** `session.create({ workspaceId })` could attach a cwd-matching unaccounted blank session. Rejected: silently attaching CLI-born sessions to a Workspace crosses the account boundary by surprise, and the client cannot distinguish "stray" from "the Workspace's own blank" without the membership view — which is the fix itself.

**Attach on reuse via a new wire operation.** Requires a `workspace.attachSession` RPC in the navigation hot path and would still render the session under Ungrouped for a frame; no product need justifies the surface.

## Consequences

Stray blank sessions remain visible in Ungrouped (the user can still open them) but are never hijacked by a Workspace's New Session flow. Membership is a new condition on the reuse scan, and it has one observable stale-mirror edge: in the window where the session mirror is fresh but the Workspace account frame lags, the Workspace's own member blank can fail the membership check and a duplicate blank is minted where the old code reused — a second `New Session` row under that Workspace rather than the old failure shape (a session that no grouping surface shows). Both windows are transient and the per-Workspace coalescing still prevents duplicate creates racing one another. No host, wire, or durable-format change.

## Testing

`packages/client/ui-workspace/tests/workspaces-service.client.spec.ts` covers the four outcomes: a member blank session is reused (no create RPC); a stray blank with matching cwd is **not** reused and a fresh accounted session is created (regression case); an archived blank is not reused; a rejected first prompt keeps a member blank eligible. The full client suite (`pnpm run test:gui`) stays green.
