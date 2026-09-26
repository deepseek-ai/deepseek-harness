# Agent Note: StateDot solid marks and loading spinner

Status: implemented

English | [中文](2026-09-17-state-dot-visual-language.zh.md)

## Problem

`StateDot` mixed two drawing languages: settled states used a translucent halo around a solid core, while `ongoing` used an eight-cell pixel chase.

## Decision

`idle`, `done`, `warning`, and `error` render as one solid 6px circle inside the existing 10px layout slot, with no halo. `idle` uses the neutral `--dsw-alias-state-idle-primary` token, `done` remains success green, `warning` remains amber, and `error` remains red.

`ongoing` is the sole non-dot member. Its default edge is 14px, while solid states retain their 10px layout slot. It renders a 25%-opacity complete ring behind a grey arc using the tertiary label token. The glyph rotates continuously over 1.5 seconds while the arc grows from 12 to 24 dash units around its center and returns to 12; the arc offset is zero at both ends, so the browser does not reset a second circular movement at the loop boundary. Reduced-motion environments retain an intermediate static arc. The explicit size override, `data-state`, and `aria-hidden` behavior do not change.

Converted compact status-only presentations use this shared mapping instead of local dots or spinners: waiting or blocked is `warning`, active work is `ongoing`, successful completion is `done`, failure is `error`, and inactive or not-yet-started work is `idle`. Tool rows whose leading slot is a business icon retain the ordinary glyph in every lifecycle state; their collapsed summary turns red for failure and amber for `stopped`, preserving any tool-specific interruption text. The framework-free boot page remains separate because its arc reports aggregate loader progress before React and the shared primitive are available.

## Alternatives considered

**Keep the pixel chase.** Rejected because its block animation did not share the circular language of the settled markers and read as a decorative activity glyph rather than a conventional loading state.

**Fill the complete 10px slot.** Rejected because the former visible core was 6px; retaining that diameter preserves row density while removing only the halo.

## Testing

The component specs pin the four solid-state elements, the two-circle loading artwork, both animation tracks, both size paths, the no-halo stylesheet, and every state token. Tool, Bash, and Skill row specs pin the retained business glyph plus visible red failure and amber interruption summaries. Workspace, Job, Workflow, Subagent, Deliverables, terminal, plugin, Schedule, Todo, Team, approval, document-preview, Trajectory, and connection suites pin their state mappings and accessible labels.

## Consequences

Consumers keep their accessibility labels while status-only presentations share one visual vocabulary. Every settled marker becomes visually quieter and more compact, completion remains green, and every active marker uses the same tertiary-grey rotating loader. Action glyphs such as reconnect and business glyphs such as file or tool types remain available when the icon itself communicates the operation rather than only its state.
