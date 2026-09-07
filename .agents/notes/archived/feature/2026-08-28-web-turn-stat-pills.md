# Agent Note: Turn-tail stat pills with anchored dialogs

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-web-turn-stat-pills.zh.md)

## Problem

A completed assistant Turn ended with two stacked footer rows: a `Turn usage` DisclosureRow above the icon actions, and a meta line inside the actions row carrying clock, run time, TTFT, and decode speed as plain text. The disclosure expanded inline and shifted the transcript below it, the meta line mixed audience tiers — casual readers want the clock and run time while token buckets and latency percentiles are diagnostic — and the two-row footprint repeated under every Turn of a long transcript.

## Decision

The tail keeps one `MessageIconActions` row. Two stat pills sit right of the branch action: a database pill labelled with the compact Turn total (`Usage 15.8K tok`) and a clock pill labelled with the wall time (`Ran for 19s`); the message clock stays plain text at the row end. Each pill is an `aria-haspopup="dialog"` trigger that portals a fixed-position dialog to `document.body`, placed above the trigger by `useAnchoredPosition` with a 12px viewport clamp and closed by outside pointerdown or Escape (ContextMeter's pattern). The usage dialog holds the exact total, provider/model routes, cache-hit rate, token buckets, and the reasoning subset inline in Output; the time dialog holds total run time, decode TPS, and the Turn's first-token latency (the first step's TTFT). Facts absent from the fold render no row, and a window without publishable Turn usage renders no usage pill; the token-meter fold and `turn/start` gating are unchanged from [exact per-Turn usage](2026-08-24-web-per-turn-token-usage.md).

Row visibility follows recency: turn tails and user rows tag `data-actions-reveal`, the latest of each kind stays `always` visible, earlier rows reveal on hover or focus-within under `@media (hover: hover)`, and no-hover devices keep every row visible. Below 480px the pill labels hide and each pill takes the sibling action-button geometry — 28px width, 6px padding, centered glyph, and no adjacent-pill margin rebate — so the bare icons keep the row's 8px rhythm.

## Alternatives considered

**One flat whole-line trigger.** A TEMPORARY `?usage-variant=flat` switch shipped both layouts to a live A/B session; the flat line exposing TTFT, TPS, and cache hit inline read as plain metadata with a weak click affordance, and its single dialog stacked two unrelated sections. The twin pills won the comparison and the switch, its locale keys, and its tests were deleted.

**Keep the inline disclosure.** Rejected: expansion shifts the transcript, and the summary row spends a permanent second line on diagnostic data under every Turn.

**Hover tooltips instead of dialogs.** Rejected: seven facts need a persistent, focusable surface, and hover cannot serve touch devices that the reveal gate already exempts.

## Consequences

`TurnUsageDisclosure` and its stylesheet are deleted; `TurnUsagePanel` owns both pills and dialogs, and `ui-chat` gains a `react-dom` dependency for the portal. Every web ARIA golden containing an assistant tail changed mechanically from `text: Ran for …` to a labelled button. Component tests pin trigger copy, dialog content, omission of absent facts, and both close paths; style-contract tests pin the secondary-tier pill typography, the recency gate, and the 480px collapse; the turn-tail e2e drives both dialogs on a recorded session and keeps tok/s and TTFT out of the tail row.
