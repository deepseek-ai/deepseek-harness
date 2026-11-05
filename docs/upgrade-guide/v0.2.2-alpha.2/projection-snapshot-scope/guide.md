---
kind: upgrade-guide
description: "Projection snapshot reads compute only the returned units, the registry cached snapshot read is deprecated, and Session list summaries omit context pressure and breakdown."
---

# Projection snapshot scope

English | [中文](guide.zh.md)

## Change

`ctx.sessionProjections.snapshot(session, keys)` from `@deepseek-ai/dsh-session-projection` computes only the units it returns: with `keys` it computes only the selected units, and without `keys` it computes every unit that defines `wire` and no Host-only unit. A plugin can no longer rely on other units being computed after it calls `snapshot`. The registry's `cachedSnapshot(session, keys)` is deprecated; it returns only values another read already computed and may omit keys. The persisted cache read `ctx.sessionProjectionCache.cachedSnapshot(header, keys)` is unchanged. `session.list` summary `projections` no longer carry `contextBreakdown` or `contextPressure`; the `@deepseek-ai/dsh-token-meter` entries are now `SessionProjectionSummaryExcluded`. Plugins and SDK or wire clients that read these values are affected.

## Migration

1. Read Host state of your own unit through the handle that `await ctx.sessionProjections.register(definition)` returns, with `handle.stateOf(session)`, instead of calling `snapshot` first and reading cells afterwards.
2. Replace calls to the registry's `cachedSnapshot(session, keys)` with `snapshot(session, keys)`.
3. Read `contextBreakdown` and `contextPressure` from an opened Session, for example the Session projection snapshot or follow baseline, instead of from `session.list` rows.
4. Rebuild your plugins and clients, confirm that type checks pass without `no-deprecated` findings for `cachedSnapshot`, and confirm that an opened Session still shows its context meter.
