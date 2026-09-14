# Agent Note: Turn duration labels gain an hour unit

Status: implemented

English | [中文](2026-09-09-turn-duration-hour-unit.zh.md)

## Problem

The Web chat's turn duration labels counted minutes without bound. `formatRunDuration` in [message-chrome.ts](../../../../packages/client/ui-chat/src/client/chat/message-chrome.ts) split elapsed milliseconds into seconds and minutes only, so a turn that ran for 90 minutes read `90分05秒` / `90m 05s` in all three places sharing the formatter: the `Deep diving...` running clock, the settled `Ran for {duration}` footer, and the turn-time dialog's total. The archived [turn run time decision](../../archived/feature/2026-08-03-web-turn-run-time.md) fixed the clock's anchor and the shared whole-second floor; it left the formatter at two units, which stops reading correctly once a turn crosses an hour.

## Decision

`formatRunDuration` carries an hour branch: elapsed time at or above 3600 seconds renders through `duration.hours` with zero-padded minutes and seconds — `1小时05分03秒` / `1h 05m 03s` — while everything below an hour keeps the existing second and minute branches unchanged. Hours appear only at or above 3600 seconds, so 3599 seconds still reads `59分59秒` and `60分00秒` never appears. Seconds are retained rather than dropped once hours appear, because the running clock ticks every second and a `1小时05分` label would sit still for a minute at a time. Negatives still clamp to zero and partial seconds still floor. `duration.hours` joins both dictionaries in [locale.ts](../../../../packages/client/ui-chat/src/client/locale.ts), and `RunDurationTranslate` widens to three keys.

The change is confined to the turn formatter. `StatsPills.formatDuration` — the session-wide aggregate pill reading `45.2s` / `2m42s` — keeps its own two-unit format.

## Alternatives considered

**Pair hours with minutes only.** Dropping seconds at the hour boundary matches the `ui-jobs` job-duration format and keeps the label short. It loses the second-level figure from the settled footer, and it makes the live clock look frozen: the label would change once a minute while the turn is still running.

**Three units while running, two once settled.** Rejected because both readings come from one function by design — the archived decision pins that — so the same turn would report different precision before and after it settles.

**Change the aggregate pill in the same change.** `StatsPills.formatDuration` measures session-wide aggregates — LLM time, tool time, and average TTFT — from projections rather than one turn's boundaries. It can exceed an hour too, but folding it in would mix two independent formatters and their tests into one change.

**Leave minutes unbounded.** `90分05秒` is technically correct and costs nothing to keep, but it is the reading that prompted this change and grows harder to parse the longer a turn runs.

## Consequences

Long turns now read in hours without new session events or new timing state; the labels remain derived from the logged `turn/start` and `turn/end` boundaries and keep the 15-second clock delay. The unit spec covers the 3599-second and 3600-second boundary plus the English template. No recorded-session snapshot changes: every shipped `Deep diving...` expectation is captured before the clock appears.
