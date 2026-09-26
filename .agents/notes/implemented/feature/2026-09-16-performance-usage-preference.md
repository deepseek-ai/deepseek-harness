# Agent Note: Performance and usage detail preference

Status: implemented

English | [中文](2026-09-16-performance-usage-preference.zh.md)

## Problem

Always-visible counts and accounting controls add density to Chat even when readers only need output speed and cache effectiveness.

## Decision

Chat owns `ui-chat.performanceUsage` in its existing settings namespace. General Settings offers Compact and Detailed, with Detailed as the default to preserve access to accounting. Both the composer and turn-tail renderer consume the same accepted settings source through framework-bound hooks. Host settings own persistence, validation, and failed-write recovery.

Compact retains only available output speed and cache-hit percentage under the composer. These readings are plain text with no statistics dialog. Detailed retains session statistic dialogs and per-Turn usage. Neither mode renders the elapsed-time action in the completed-turn footer. This preference changes presentation, never telemetry collection, accounting, or Session events.

The [composer statistics decision](2026-09-07-composer-session-stats-pills.md) remains authoritative for accounting sources, dialog exclusivity, and composer spacing in Detailed mode.

The requested footer design prioritizes message actions and token accounting in both modes. Completed turns therefore expose no per-turn elapsed-time control; Detailed restores accounting detail, not that control. The running clock and session-wide timing statistics remain independent of this choice.

## Alternatives considered

**Default to Compact.** This would hide accounting controls for existing users without an explicit choice. The request defines both modes but no default, so Detailed preserves their access.

**Filter telemetry when Compact is selected.** This would discard information needed after switching to Detailed or reopening history. A display preference must not change recorded data.

## Consequences

Unavailable speed or cache-hit data is omitted rather than replaced with invented values. The settings scope provides one accepted value to all consumers without duplicating subscription state. Component coverage checks mode-specific visibility; the [recorded-session browser scenario](../../../../apps/web/tests/message-actions.e2e.ts) exercises selection, reload persistence, and Compact output.

On non-loopback browsers, the preference remains process-local because the settings scope cannot persist writes. Explicit selections update every consumer immediately; accepted Host settings reconcile the live value on loopback browsers.
