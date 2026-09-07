# Agent Note: Adaptive and drag-resizable conversation content width

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-conversation-adaptive-content-width.zh.md)

## Problem

The conversation column's shared width axis (`--dsh-chat-content-width`) was the fixed figma constant 748px. On wide monitors (a 4000px display leaves a ~3500px column) the transcript occupied under a quarter of the column with dead margins on both sides. Every derived surface — the input card (W + 32px), dock cards, takeover panels, StatsLine, the back-to-bottom padding formula — rides this one variable, so any change had to keep the whole column's alignment relations intact. Alongside the adaptive default, users asked for direct control: hover the transcript's side margins to get a col-resize cursor and drag either edge, with both edges moving symmetrically.

## Decision

**The axis becomes a user override over an adaptive clamp.** `ConversationRoot.module.css` declares `--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px))`. The floor is 680px — one step under the figma 748px, after full-width reading felt wide on every screen — wider columns take 64% of the column, and 920px caps line length for readability (~113 characters at the base font). A dragged preference replaces the adaptive term wholesale.

**The column width is published by a ResizeObserver, not container queries.** The component publishes the root's `offsetWidth` as `--dsh-conversation-column-width` in px (the same callback-ref pattern as the existing composer seat height observer). `container-type: inline-size` was rejected: the conversation subtree contains portal-free `position: fixed` descendants (Tooltip, Menu, JsonTree copy anchors) whose viewport anchoring a size container would capture — the same class of trap the `.composerHero` comment records for transforms. A bare `%` in the variable was rejected because custom-property percentages resolve per consumer against different containing blocks, breaking the input-card = W + 32px invariant; `vw` was rejected because the column is not the viewport (sidebar fold changes the column only).

**Drag handles are 40px strips beside the transcript, symmetric by construction.** Each strip's inner edge sits 24px outside the content column and extends 40px outward, with the outer edge clamped to keep a 24px safe zone from the column edges (24 + 40 + 24 = the 88px-per-side budget below); when the margin cannot fit inset + strip + safe zone the computed width goes negative and the strip resolves to zero. Both handles write the one centered width — outward travel widens by 2× the pointer distance — reusing AppFrame's DragHandle capture model (pointer capture + rAF throttle + drag-start snapshot); only a gesture with actual pointer travel commits to storage, so a bare press-and-release on a window-clamped width cannot overwrite the wider stored preference. The hover indicator is a 3px glow riding the pointer's Y (published as `--dsh-width-handle-pointer-y` on pointermove): a 24px solid core fading over 40px each side, in the scrollbar hover tint because border-token alphas disappear against the base fill. Handles render only in the active phase; views that elect a composer overlay (trajectory) hide them, and the header lifts above them (z-index 9) to stay clickable.

**The preference persists in `localStorage` (`dsh.conversation.contentWidth`) and clamps without rewriting.** The displayed width re-clamps to `[640px, column − 176px]` when the column shrinks (88px per side keeps the handles fully placeable — a wider drag would push its own handles off the column), but the stored preference survives — widening the window restores it, the same rule AppFrame's sidebar drag follows. The handle carries no reset affordance and no tooltip; a stored preference is only ever replaced by another drag.

**The user bubble cap follows the axis.** `min(525px, 82%)` becomes `min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)` (0.702 = 525/748, the figma bubble share of the figma column) in both `ui-conversation` MessageItem and the symmetric `ui-goal` command bubble, so bubbles scale with the column. The 748px fallback covers mounts outside the conversation column.

## Alternatives considered

**Raise the constant (748 → ~850).** Rejected: every mid-width window's line length grows too, hurting readability where most users live.

**Wide-content bleed (code blocks and tool cards break out of the prose column).** Best reading ergonomics but touches MarkdownText and every tool card's layout; deferred as a possible second phase.

**A settings-backed "wide mode" toggle.** Adds a persistent settings surface for what drag already covers; not needed.

**A 12px handle strip beside the input card.** Shipped first and unusable in practice: on a wide screen the strip was a sliver in a thousand-plus pixels of margin, and the sticky input card overlapped it. Replaced by the 40px strip anchored to the glow line's position.

## Consequences

Ordinary windows read slightly narrower than the figma baseline (680px floor). Wide columns widen the transcript to at most 920px, and a drag can take it anywhere in `[640px, column − 176px]`, both without touching any derived surface: input card, dock cards, takeover panels, and the back-to-bottom formula follow the axis they already consumed. A known ~4px centering offset between the handle (column-centered) and the content box (centered after scrollbar-gutter reservation) stays well inside the 40px strip. The 680px / 64% / 920px numbers are one declaration in `ConversationRoot.module.css` mirrored by `resolveContentWidth` in the component; retuning them touches nothing else.
