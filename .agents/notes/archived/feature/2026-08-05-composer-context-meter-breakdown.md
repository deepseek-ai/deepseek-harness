# Agent Note: Composer context meter with heuristic composition breakdown

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-composer-context-meter-breakdown.zh.md)

## Problem

The Web chat's stats line showed context occupancy as one inline figure (`Context N% of X`) among its billing groups. That answers "how full" but not "what fills it": nothing showed how the window divides between the system prompt, tool schemas, and conversation, and the one-line row has no room for that detail. The available numbers also live in two vocabularies — the provider-exact billed prompt size from `contextPressure` versus the token-meter's fixed character heuristic — and no existing surface could present composition without conflating them.

## Decision

Three cooperating pieces, one per package boundary:

`dsh-session` exports the pure `deriveEventMessage(event)` (previously reachable only as a `Session` method, which now delegates to it) so a host-side fold can price surface nodes without a `Session` instance.

`dsh-token-meter` extracts its pricing heuristic into `src/estimate.ts` (shared verbatim with the measurement service) and registers a third session projection, `contextBreakdown`, carrying `systemTokens` / `toolsTokens` / `messageTokens`. Envelope figures reprice last-wins on each `request/header` through `canonicalHeader`; the message figure rides the O(1) shadow-price fold in `src/surface-projection.ts`, so on fully metered logs it equals `measure().surfaceTokens` at every event boundary and compaction shrinks it by its logged shadow price. The measurement service's own positional fold lives in `src/surface-fold.ts` as a plan/commit pair ([in-place surface commit](../bug-fix/2026-08-24-token-meter-surface-fold-plan-commit.md)): a throw leaves the replay cursor unmoved and the same malformed event fails identically on retry, and a replace range absent from the folded surface throws — committed logs are surface-validated at append time, so an unresolvable range is log corruption, not a skippable event.

`ui-conversation` moves context occupancy off the stats line (one home per fact) onto a composer-trailing `ContextMeter`: a 14px occupancy ring after the model seat fed by `contextPressure`, click-opening a panel that pairs the provider-exact percent and `~used / capacity` header with a 4px color-segmented bar and `~`-prefixed composition rows. The two vocabularies deliberately never reconcile — the heuristic shares only proportion the bar's colored segments and rows, each marked `~` because the fixed 4-chars-per-token heuristic systematically underprices CJK text and code. (The ring, header, and bar length were provider-exact as shipped here; they now read the provider-anchored `projectedTokens` instead, because the bare sample could not see a compaction — see [the meter's compaction blindness](../bug-fix/2026-08-05-context-meter-blind-to-compaction.md).) The header is one localized sentence (`context.aria`, shared with the ring's accessible name) split around its `{percent}` slot, so each locale owns the reading's position — English leads with it, Chinese trails it — while the reading keeps its own tone; a bar part whose width computes to zero is dropped rather than rendered, because `.segment`'s min-width would otherwise paint a filled sliver at 0% occupancy.

## Alternatives considered

**Deriving composition client-side from the loaded window.** The window is a contiguous log suffix: the `request/header` events carrying the system prompt and tool schemas may sit outside it, and paging would silently change the figures. Only a durable host-side projection survives paging and compaction, which is why the data crosses the wire as a third projection rather than a chat-window fold.

**Scaling the heuristic rows to sum to `pressureTokens`.** Forced reconciliation fabricates precision: pressure lags one request, includes provider envelope overhead the estimator never models, and would make the rows move when nothing in the composition changed. Showing the estimator's real vocabulary with an explicit `~` was chosen instead.

**Finer categories (rules, skills, MCP tools) as in Claude Code's `/context`.** Not separable here: the harness folds those contributions into the system text and the tools list before the request header exists, so three categories are the honest resolution.

## Consequences

Token-meter now registers three projection keys; unloading removes all three, and `contextBreakdown` restores from JSON checkpoints (`stateVersion` 2). The stats line dropped its Context group and the ring is the sole context UI. The panel's heuristic rows visibly disagree with the provider-exact header — accepted and signposted by the `~` prefix; improving estimate accuracy (for example CJK-aware weighting) is localized to `estimate.ts` and changes no seam. The legend's purple segment tint is a literal color because the design platform ships no purple static token.
