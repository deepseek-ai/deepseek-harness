# Agent Note: Web clickable-link language — link alias, dotted hover underline, category glyphs

Status: implemented

English | [中文](2026-09-04-web-clickable-link-styles.zh.md)

## Problem

Clickable artifact links in the chat transcript wore four different costumes: markdown anchors and prose file mentions were business-primary blue with a solid hover underline, web search/fetch links matched that pair, produced-file chips were grey pills (label-secondary text on interactive-bg-hover, 96px max width), and workflow member links carried a resting solid underline. Nothing marked what a link opens (browser, host app, Finder, in-app view), and link color was coupled to `--dsw-alias-state-business-primary`, which also drives focus rings and state dots, so tuning link color risked unrelated surfaces.

## Decision

One link language across the transcript's clickable-link surfaces — markdown anchors (including reference links, mailto, and URL-promoted inline code), prose file mentions, web search source links and the fetch URL, produced-file chips, and workflow member links:

- Color comes through a dedicated `--dsw-alias-link` alias in `design-platform.css` (light `deepseek-500`, dark `deepseek-400`), decoupled from `state-business-primary`; links render at `font-weight: 500` with no underline at rest and `underline dotted` at 3px offset on hover/focus.
- A leading category glyph — the new `LinkIcon` in ui-primitives with kinds `url` (globe), `folder`, `code`, `image`, `document`, and `other` (paper) — renders `currentColor` only; `classifyLinkPath` derives the file kinds from the extension, and code, web, and data extensions share the code glyph by design. Two anchor shapes carry no glyph: workflow member links (an in-app member view fits no file or URL category) and anchors wrapping only images (a badge or thumbnail — a dangling globe beside the picture leads no text). Inline glyphs sit at 1.1em with a −0.25em baseline offset; the flex-centered produced-file glyphs instead nudge 1.2px down because the 22px text box carries its glyphs below box center.
- Produced-file chips drop the grey pill and the 96px cap: plain link-blue text at natural width that shrinks with ellipsis only when the row overflows; the container-query bands still budget 96px per chip when choosing how many chips to show.
- Deliberately untouched: ToolRow's grey dotted file links, and the grey "Show in folder" action (it gains the folder glyph but keeps its grey style).
- In the same pass, the inline-code chip tint moved from `neutral-bluish-100` to `neutral-50` (dark: `neutral-800`) and gained a 0.5px l1 border.

Coverage: a LinkIcon unit spec (one distinct glyph per kind, classification table), refreshed markdown-dom fixtures, and the `clickable-links-gallery` web e2e — one settled keyless turn rendering every clickable link form — registered in the host compiler face (`tsconfig.host.json`) like its other scaffold-importing siblings.

## Alternatives considered

- **Colored Word/Excel/PPT/PDF brand glyphs.** Implemented, then removed: fixed brand fills break the icon set's currentColor-only rule, so those extensions fold into the single outline `document` glyph.
- **Per-extension icons.** Collapsed to six categories: more glyphs than the eye can parse at 14px adds noise, and per-site favicons remain possible later behind the same `url` category.
- **Keeping links on `state-business-primary`.** Darker link blues (blue-600/650/700 were auditioned and reverted) would have dragged focus rings and state dots along; the dedicated alias localizes any future tuning to one line.
- **Glyphs on ToolRow path links.** Rejected: tool rows keep their quieter grey dotted affordance, and leading glyphs there would stack icons in already dense rows.

## Consequences

- A new clickable artifact surface should consume `--dsw-alias-link` and the LinkIcon vocabulary rather than introduce another color or underline form; the rule lives in [docs/web-styling.md](../../../../docs/web-styling.md).
- Long produced-file names take their natural width; when a row overflows, flex shrinks all chips proportionally, so several long names shrink together instead of the last one yielding first.
- mailto links currently share the `url` globe; a distinct mail category is a one-line addition if ever wanted.
