# Agent Note: Settings-backed conversation content font size

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-settings-font-size-control.zh.md)

## Problem

The conversation's body text size was fixed (14px after the 0.875 markdown-ladder rescale). Users asked for a Settings control: a "字号大小" row under General → Appearance with a stepper, range 12–17, default 14, that resizes the transcript body text and the composer input text together.

## Decision

**The theme plugin owns the setting.** `ThemeSettingsSchema` gains `fontSize` (`z.number().step(1).min(12).max(17).default(14)`) beside `preference` in the existing `ui-theme` namespace — one durable section, one settings scope, one adoption path. `ThemeRuntime` carries `fontSize` in `ThemeSnapshot`, exposes `setFontSize(px)` (integer-and-range validated, throws a teaching error), and republishes on `theme/change`. The same plugin registers the FontSizeRow into `settings.general.item` at order 11, directly under the Appearance cubes (order 10).

**Presentation rides the existing snapshot pipeline.** The service never touches the DOM: ui-layout's `ThemePresenter` writes `--dsh-content-font-size` on `body` from each snapshot (and retracts it on dispose), and the Host boot script embeds the durable value in the index response so first paint uses the chosen size — the same pre-plugin path the dark-mode attribute takes, avoiding a font-size flash.

**One CSS delta variable moves the ladder, plus a derived secondary tier.** `gradient-shadow-text.css` derives `--dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px)` and shifts the markdown h1–h4 and base variants (size and line height) by that same px increment, preserving the heading hierarchy and each variant's leading. Secondary-tier text — one step under the body — reads `--dsh-content-font-size-secondary: min(setting − 1px, max(13px, setting − 2px))`: setting −1 at ≤14, setting −2 above (12→11, 13→12, 14→13, 15→13, 16→14, 17→15), with `--dsh-content-font-delta-secondary` (secondary − 13px) moving its line heights. The secondary tier covers the markdown table variants, the shared DisclosureRow title (tool calls, think, commands), ToolRow/bash-row summaries and file links, think text, compaction/context/retry/error rows, StatsLine, the chat hint and open-error strips, the workflow-run panel headers/counts/statuses, the turn-status clock, reference summaries, and the note-trigger label. Small and code variants stay fixed — as does the interrupted-turn `.stopped` tag (11px): they are dense secondary text whose defaults would fall below legibility when stepped down. Consumers outside the token ladder at the body size read `var(--dsh-content-font-size, 14px)` and `calc(<default line-height> + var(--dsh-content-font-delta, 0px))` directly: the assistant narration root, the user bubble (inline reference glyphs included), the composer card (whose textarea/mirror/backdrop stack inherits font metrics from the card by design), the compaction/DisclosureRow geometry (row height, leading box, expanded bodies' `22px + delta` indent), the message clock and icon actions (slot-injected message-feedback actions match through the same variables), and the turn status line. Flow icons scale through each leading box's CSS edge (`svg` width/height overriding the glyph attributes); StateDot is exempt via its `data-state` attribute — a status mark, not text furniture. The fallbacks (14px body, 13px secondary) keep every surface pixel-identical when the variables are absent (tests, storybook-like mounts, remote compositions before adoption).

**The stepper is a pill, not a menu.** The row reuses the selector-pill geometry (h36 r18 module fill) with the value centered in the pill, the up/down arrow column revealed on hover/focus-within and absolutely anchored to the pill's right edge (so revealing never moves the value), and a `px` unit label after the pill. A tertiary description line under the title states the scope — the size only affects conversation content, not the application chrome. Arrows disable at the bounds; the display follows the store mirror, never the click echo — the same store/face pattern as the Appearance row.

## Alternatives considered

**A separate settings namespace or plugin.** Rejected: the font size is an appearance preference with the same persistence, adoption, and remote-browser semantics as the theme preference; a second namespace duplicates the scope machinery for one integer.

**Scaling via a multiplier (`em`/percentage) instead of a px delta.** Rejected: multiplying spreads the 12–17px range disproportionately across the ladder (21px h1 would swing ~18–25.5px) and produces fractional line heights; the fixed px shift keeps every step integer and the hierarchy's px gaps intact.

**Scaling every font token (small, code).** Rejected: those variants are dense by design; at −2 the small ladder would hit 10px and code 9px, below legibility. The table variants instead join the secondary tier, bottoming out at 11px at the 12px setting — the same size think text reaches there.

## Consequences

The 0.875 markdown-ladder rescale (body 16 → 14) ships with this change as the new default rendering; at the default setting the body-size consumers match that rescaled baseline, and the secondary tier renders at 13px (one step down — a deliberate demotion of the flow-row titles and summaries that previously sat at the body size). Surfaces without the variables fall back to the same defaults. A changed size persists in `$DSH_HOME/settings.yaml`, survives reloads without flashing (the boot script writes the durable value pre-hydration and `ThemeRuntime` seeds its initial snapshot from it), applies live across transcript and composer, and remote browsers keep the process-local-selection rule the theme preference already has. `setFontSize` joins the model-visible cordis client API catalog beside `setTheme`.
