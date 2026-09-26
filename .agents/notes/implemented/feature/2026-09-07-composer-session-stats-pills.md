# Agent Note: Composer session stats — two icon pills with click-open stat dialogs

Status: implemented

English | [中文](2026-09-07-composer-session-stats-pills.zh.md)

## Problem

The session stats strip under the composer (`StatsLine`, ui-chat, mounted on `conversation.composer.dock`) rendered every figure as one resident text line: turn/step counts, LLM and tool wall times, TTFT/TPS averages, and compact token totals with cache-hit share. The line crowded as figures accumulated, exact token counts appeared nowhere (the `ResizeObserver`-measured hover tooltip only restated the same compact line when it truncated), and the flat text gave no grouping — time figures and billing figures read as one undifferentiated row. An in-page A/B against a two-pill variant settled the direction: the pills won on scannability and on giving each figure family a home.

## Decision

The [performance and usage preference](2026-09-16-performance-usage-preference.md) governs statistic visibility and removes the completed-turn elapsed-time action.

`StatsPills` (packages/client/ui-chat/src/client/chat/StatsPills.tsx) replaces `StatsLine` on the same `conversation.composer.dock` slot; the losing variant is deleted, its shared helpers (`deriveStats`, `formatDuration`, `cacheHitPercent`, `billedInputTokens`) absorbed into the new module, and the dead `stats.llm`, `stats.toolCall`, `stats.ttftAverage`, `stats.tokensPerSecond`, and `stats.tokens` locale keys removed.

- **Two icon pills, two dialogs.** A gauge pill (new `IconGaugeOutlineRegular`, dial center optically dropped to y=8.75 because the bottom-open arc reads high) shows `{turns} 轮 {steps} 步` plus output TPS and click-opens the 会话统计 dialog (LLM time, tool time, average TTFT, TPS); a log with no timed figure would open an empty dialog, so that pill renders as a static reading instead of a button. A database pill (`IconDatabaseOutlineRegular`) shows the compact billed total plus cache-hit share and click-opens the Token 用量 dialog (cache hit, uncached input, cache read, output, and cache write when non-zero — exact counts). Both dialogs wear the shared `stat-dialog` module (portal panel, anchored placement, outside-dismiss, optionally externally owned open state) extracted for exactly this two-consumer split; the pills row owns one exclusive open slot, so opening either dialog closes the other, and each button carries an explicit `aria-label` that separates with ` · ` the segments the aria-hidden sep glyph joins visually. [StatsPills](../../../../packages/client/ui-chat/src/client/chat/StatsPills.tsx) owns the zero cache-write omission.
- **Shared information tier.** Composer stats and per-turn tail metadata use the secondary font size minus one pixel. Assistant-tail metadata uses the action icons' tertiary label color and starts after an extra 8px separation from the action cluster.
- **Data sourcing is unchanged in architecture.** Counts and times prefer the durable `sessionStats` projection with the window fold as the assembly-without-the-unit fallback ([whole-session counts](../../archived/bug-fix/2026-08-12-full-session-turn-step-counts.md)); token figures ride `tokenUsage` only, so an absent projection drops the usage pill rather than showing window-derived billing. Cache writes stay in the billed total and the cache-hit denominator ([projection decision](../architecture/2026-07-29-projected-token-usage-and-request-context.md)). Context occupancy remains owned by ui-conversation's `ContextMeter`, with its ring and percentage after the two stats pills below the input card. The common dock groups statistics together and leaves the toolbar for input actions; ui-chat does not import the context component. The context panel renders through a portal and uses ui-primitives for viewport-clamped positioning and outside-pointer dismissal, including when the statistics contribution is absent.
- **Render discipline.** The row folds settled nodes only (`chat.legacy.nodes` identity), so streaming chunk frames cause zero rerenders — pinned by a render-count unit test. A session with no closed step and no billed tokens renders nothing.
- **The composer owns dock spacing.** `InputBar` places slot contributions and `ContextMeter` in one centered flex row, supplies 4px above the dock and 4px below it even when the slot has no visible contribution. The hero keeps no bottom padding and hides its empty dock. `StatsPills` supplies shrinkable time and billing content; it does not claim the full row width or add outer padding.

## Alternatives considered

- **The single-line variant (StatsLine, the A/B loser).** All figures resident in one text row, with a hover tooltip restating the full line when it truncated. Lost on crowding and reach: exact token counts appeared nowhere (the line and its tooltip both carried compact totals only), and one row gave time and billing figures no visual grouping.
- **Three resident groups with one shared dialog.** An intermediate iteration kept counts, time, and tokens as three inline groups. Two pills won because the time/usage split matches the two underlying projections one-to-one and each pill's icon telegraphs its dialog.
- **Extracting the dl bucket rows shared with `TurnUsagePanel`.** The session-total dialog and the per-turn panel render the same skin but different contracts (required session input, cache-read, and output rows plus a non-zero cache-write row, versus optional per-turn fields and model routes); a shared component would be conditionals around nine lines. The mirror is marked `jscpd:ignore` with the reason inline.

## Consequences

- `ChatSnapshotBuilder`'s legacy slice now serves StatsPills; the [node-assembly note](../architecture/2026-08-09-client-conversation-node-assembly.md) tracks that consumer rename.
- Exact token counts become reachable at all — one click — where `StatsLine` showed only compact totals; the strip itself carries only the two headline readings.
- Web e2e strip assertions match substring text inside the time pill; the fresh-round-trip aria goldens pin time, billing, and context order below the submit action, and stats-paged-history pins the counts reading alone over a log with no billed tokens.
- The `conversation.composer.dock` occupant in the generated slot catalog is `client-ui-chat StatsPills id 'stats'`.
