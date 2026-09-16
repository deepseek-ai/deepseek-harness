# Agent Note: Transcript width handles stay behind chat content

Status: implemented

English | [中文](2026-09-14-transcript-width-handle-layering.zh.md)

## Problem

The Conversation shell renders each content-width handle as a full-height absolute strip beside the reading column. A high stacking level placed that strip above wide Markdown tables that legitimately overflow the column. The handle glow covered their content and its pointer target could replace their interaction target.

## Decision

The Conversation shell keeps width handles at level zero without creating a body-wide stacking context. Chat raises concrete table elements to level one, while the reading column, column-bounded tool cards, and table breakout wrapper create no new stacking level. A table therefore owns the gutter only where its painted box actually reaches it; a fitting four-column table leaves the adjacent gutter draggable. Fixed message tooltips remain outside the table stacking context and can still paint over the sticky composer.

This rule relies on the supported Chromium engine not turning ChatView's inline-size query container into an intermediate stacking context. The same engine behavior already lets the back-to-bottom control outrank the sticky composer. The Chromium hit-test scenario pins that assumption; raising the whole Chat root would instead make its transparent full-width box reclaim the gutter.

A width handle starts resizing only for the primary pointer button. Ordinary wheel input over the handle is normalized from pixel, computed line-height, or page units and forwarded to the direct sibling transcript scrollport, so hovering the gutter does not suspend reading. Ctrl+wheel is not forwarded because it represents browser zoom or a trackpad pinch gesture.

Each side's hit strip is at most 10px wide. Its hover indicator uses the lower-contrast resting scrollbar tint and is a 2px line with a 16px solid center and 28px fades, for a 72px total visible length.

Composer chrome retains its higher layer, so its full sticky footer band intentionally does not start a width resize. A handle whose pointer capture began above that band temporarily rises to level eight, keeping the indicator visible until release. A full-view composer takeover continues to hide the handles entirely.

## Alternatives considered

**Move the handles farther from the reading column.** Wide tables can use the available transcript width, so a fixed larger inset would only reduce the overlap for some window sizes and would make the handles harder to reach.

**Disable the handles whenever a transcript contains wide content.** One wide row would remove resizing from the entire Session, including empty gutter beside unrelated rows.

**Inspect the elements under the pointer in JavaScript.** Dynamic hit testing would duplicate browser stacking and pointer dispatch rules and could still disagree with new plugin renderers.

## Consequences

Visible Chat content owns pointer input only where its painted element extends into a width-handle strip, while bare gutter keeps a quieter resize affordance, primary-button drag, and transcript wheel scrolling. Unit tests pin the declared handle geometry, pointer-button behavior, direct scrollport lookup, zoom exclusion, and every DOM delta mode. Chromium `elementFromPoint` coverage proves an overflowing table wins the hit while a fitting `md-table-wide` wrapper does not, and a message-action test proves fixed tooltips still paint above the sticky composer.
