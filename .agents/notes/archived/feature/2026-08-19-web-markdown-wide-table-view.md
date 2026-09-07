# Agent Note: Web markdown tables fill the column by count, wide ones break out

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-19-web-markdown-wide-table-view.zh.md)

## Problem

`MarkdownText` rendered every GFM table at its natural width (`.tableScroll table { width: max-content; max-width: max-content }`, `packages/client/ui-primitives/src/markdown/MarkdownText.module.css`), so any table wider than the 748px message column could only be read through horizontal scrolling. A three-column table whose cells could comfortably wrap still forced a scroll, and a genuinely wide table could never use more than the message column even when the transcript around it had hundreds of spare pixels. Issue #1761 (with external feedback dsh-external/issues#520) asks for wrap-first adaptation and a wider view for tables that need it. The deepsuite chat product solved the same problem CSS-first; per review direction this change mirrors that solution instead of the interactive expand-dialog approach first drafted here.

## Decision

**Column count picks the sizing arm, statically, in the renderer.** `renderTable` reads the parsed column count (the `align` array, header-row fallback): tables under four columns — and any table inside a blockquote (`inBlockquote` render-context flag) — get the module's `tableFill` class, `table { width: 100%; max-width: none }`, filling the column with cells wrapping down to their existing `min-width: 100px` floor. Four-or-more-column tables keep the natural-width rules and instead carry the stable global hook class `md-table-wide` (the `md-code-block` precedent), so a hosting layout can widen them. This is deepsuite chat's discriminator (`.wrapper:not(:has(th:nth-child(4), td:nth-child(4)))` plus its blockquote exemption) computed in the renderer, which already knows the column count. No measurement, observers, or interaction state anywhere.

**The chat transcript widens hooked tables with container-query CSS.** ChatView's `.scroll` declares `container-type: inline-size`, and `AssistantMarkdown.module.css` gives `.body :global(.md-table-wide)` the breakout: `--dsh-table-spare` is the per-side spare width `max(0px, (100cqw - --dsh-chat-content-width) / 2)`, `--dsh-table-lead` adds the wrapper's own indent (`min(--dsh-chat-content-width, 100cqw) - 100%`), and width/negative-margin/lead-padding combine so the wrapper's scroll area spans the full transcript while the table content keeps starting at the message column's left edge. `100cqw` is the CSS stand-in for deepsuite chat's JS-measured `--dsl-virtual-list-width`; the `max(0px, …)` clamp replaces its below-SM JS gate, degrading continuously to the plain in-column scroll when the transcript is narrower than the message column. Scoping the rule under `AssistantMarkdown .body` keeps tool cards, compaction rows, and every other `MarkdownText` surface at plain in-column behavior.

**The parity fixtures change deliberately.** The table-containing markdown-dom fixtures pin the discriminator: `tableScroll tableFill` for narrow and blockquote tables, `tableScroll md-table-wide` for wide ones, and a new `table-wide-and-blockquote` corpus document pins both arms of the blockquote exemption.

## Alternatives considered

**Overflow-measured chrome: a ResizeObserver-gated expand entry opening the table in a `Modal` wide view.** Implemented first, then rejected on review direction in favor of deepsuite chat parity: the CSS solution needs no per-table observers, no dialog state that the streaming finalize swap would drop, no label plumbing through the cordis-free package, and gives the wide view permanently instead of behind an interaction.

**`:has()`-based column counting in CSS, as deepsuite chat does.** Rejected: their wrapper is generic while this renderer already walks the table node, so the count is available statically; a class is cheaper than a `:has()` selector re-evaluated on DOM changes and pins the decision in the DOM for fixtures.

**Breaking out to the viewport rather than the transcript.** Rejected: the conversation column pins `overflow-x: hidden` (the one-axis contract in `apps/web/tests/conversation-column-overflow.e2e.ts`), and anything wider than the transcript box would clip; the transcript width is exactly the space the layout actually has.

## Consequences

An ordinary wide table reads in place with wrapped cells; a many-column table keeps its readable natural width, spans the whole transcript where the layout has spare width, and scrolls for the remainder — with no interaction required and nothing to restore. A wide table's horizontal bar reveals on hover instead of staying painted: Chromium never repaints state-conditioned scrollbar styles (neither hover-conditioned `::-webkit-scrollbar*` rules nor a `:hover` `scrollbar-color` change reaches the painted bar — measured headed and headless), so the reveal toggles `overflow-x` itself (`hidden` at rest, `auto` on hover or focus), with resting `padding-bottom` matching the themed bar height so the appearing bar replaces it without moving content below. Resting `overflow-x: hidden` drops Chromium's implicit scroller focusability, so wide wrappers carry an explicit `tabindex="0"` (a `:focus-visible` ring marks them, and focus restores scrolling for arrow keys). Two knowledge edges: `container-type: inline-size` on ChatView's `.scroll` makes it the nearest query container for anything inside the transcript that later uses container units, and sub-four-column tables now always stretch to the full column width (deepsuite chat behavior) rather than shrink-wrapping short content.

## Testing

The markdown-dom parity fixtures pin the wrapper classes per arm, including the new `table-wide-and-blockquote` document; `markdown-render-units.client.spec.tsx` covers the hand-built rowless/align-less fallback. `apps/web/tests/markdown-wide-table.e2e.ts` seeds a closed turn with three tables (three-column fill, twelve-column wide, long-token/CJK long-cell) and, in real Chromium, pins the relations golden across viewport stops — fill and long-cell tables fill the column with no residual scroll at every stop and grow taller as the column narrows, the wide table always scrolls, breaks out past the message column exactly at the stops where the transcript is wider than it, keeps its content left-aligned with the fill table's under the breakout, and clamps to neutral at the narrow stop — plus arrow-key scrolling of the focused wrapper, a zoom arm, and a deviceScaleFactor-2 arm that must report the same relations.

## Related

- [Web markdown incremental AST renderer](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md) — the renderer and DOM-parity contract this change extends.
