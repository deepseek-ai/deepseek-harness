# Agent Note: Web tool-row unified expand and trajectory Inspect

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-web-tool-row-unified-expand-and-inspect.zh.md)

## Problem

The chat view's tool rows had drifted into per-surface interaction dialects: ToolRow expanded through a leading-icon toggle and only for calls with an args body, the bash sample had its own expand affordance, todo/ask-question rows expanded raw args only, single-file tools were not expandable at all, and a call's OUTPUT was reachable only through the details panel. A failing bash command (exit≠0 settles `isError:false`) showed no collapsed-row failure signal. There was also no path from a chat row to its trajectory record, and switching chat → trajectory → chat lost the reader's scroll position because the tab ring unmounts inactive views.

## Decision

**Every expandable tool row shares one interaction — the whole row toggles (click / Enter / Space) with an icon→chevron hover preview — and one expanded body: an IN/OUT gutter-labeled card with per-section scroll caps; a hover-revealed Inspect pill jumps to the call's trajectory record through a one-shot store handoff; the chat view preserves its semantic reading position across view switches through an in-memory per-session map.**

- `toolRowModel` now derives result material alongside args: `output` (the `resultText` flatten, moved from DetailsPanel into the contract), and `errorSummary` (the failure's first line, shown as the collapsed summary in the error color). A row with body, output, or terminal material is expandable; the row itself is the toggle (`role="button"`, `aria-expanded`), and file-path summaries stay independent links via `stopPropagation`.
- The expanded card (figma 1249:35657) is a column of IN/OUT sections: each section is its own scrollport (max-height 150px) with a sticky gutter label, and the l2 divider spans the full card width. Think prose and the run_code CodeBlock keep their non-card bodies; context injection reuses the row with a label-less `plainBody` card.
- `terminalFailed` reads a settled terminal card's exit status so BashRow and GenericToolCard surface a failing command as the row's red state dot — the only failure signal the collapsed row has, since the call itself settles `isError:false`.
- TerminalBlock's banner joins the same reading model: it shares the card surface (no banner token), an l2 hairline separates it from the body, the command column caps at 150px and scrolls with sticky copy/status controls top-aligned to the first prompt row.
- Inspect: `ToolCallOwnerProps.inspect` (absent for rows without a call identity) renders a pill in real flow under the expanded body's bottom-left, revealed by hovering anywhere on the tool call. Clicking writes `{ callId }` to the chat store's one-shot `inspect` field and switches to the trajectory view; TrajectoryTable finds the record, opens its summary, and acknowledges by clearing the field.
- Scroll preservation: on every non-bottom scroll, the chat view saves `{ anchorKey, anchorTop, scrollTop }` into an apply-scope per-session map exposed as `chatScroll`; a remount first uses `scrollTop` to reach the approximate window, then corrects by the stable node/call anchor's rectangle delta so width reflow keeps the same reading row in place. Every pinned path, including Back to bottom, clears the entry synchronously before a tab or session switch. The map remains deliberately unpersisted — a fresh page load keeps the open-jump-to-bottom default.

## Alternatives considered

**Keeping the leading-icon toggle and per-registrant expand affordances.** Rejected: three surfaces had already diverged; the registrant posture (bash sample replicates CSS locally) makes drift permanent unless the interaction contract itself is uniform and small — whole-row toggle plus hover preview.

**Routing Inspect through a URL or a trajectory-view prop.** Rejected: the view ring renders through the slot registry, so the two views share no parent that could carry a prop; the chat store already crosses that boundary and the one-shot field keeps the handoff replay-safe (persisted snapshots from before the field rehydrate with `?? null`).

**Persisting the chat scroll offset.** Rejected: restoring a days-old offset into a conversation that has since grown reads as a bug; the in-memory map scopes the memory to exactly the view-switch case that loses it.

**A per-row expanded OUTPUT fetched from the details panel's material.** Unnecessary: the settled result node already rides the snapshot's frozen call slice, so the contract-level `resultText` flatten serves both the row and the panel from one derivation.

## Consequences

Built-in ui-tool views get input and output inspection in place, with the details panel and trajectory remaining the deep-dive surfaces. The shared `ToolRow` interaction is internal to ui-tool; an external atomic view receives `ToolCallViewProps` and may expose the supplied `inspect` callback through its own chrome. The bash view keeps its separate CSS, so future interaction changes still touch it explicitly. `--dsw-font-markdown-code-block-small` (12/18) is a hand-added token pending a design-platform export. The web-cordis `distIndex` fix (plain concatenation, not URL.pathname) unblocks preview boots from a cwd with spaces.
