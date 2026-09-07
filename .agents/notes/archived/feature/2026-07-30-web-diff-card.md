# Agent Note: Web diff card — the write/edit render intent reaches the browser

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-web-diff-card.zh.md)

## Problem

The `write` and `edit` tools declare `card: 'diff'` for both their call and their result ([render-intent union](../architecture/2026-07-02-tool-render-intent-union.md)): the call view carries the intended change derived from the arguments, and the result view carries the applied contextual hunks (`FileDiff[]`, computed by `packages/fs/tool-fs/src/diff.ts` and persisted in the result `meta` so replay reproduces it). That view already reaches the browser — host, connection, and runtime deliver it onto `ConversationSnapshot` as `callView`/`resultView` — and the TUI already renders it as per-file `+`/`-` blocks with a `+A -R · N file(s)` footer.

The Web client ignored it. A write/edit call landed on `GenericToolCard`, whose row is derived from raw tool args, and the details panel flattened the result's content blocks into one `<pre>`. The `diffs` payload — the whole point of the result — was discarded, so a file mutation read as a one-line confirmation with no visible change.

This is the [terminal card](2026-07-28-web-terminal-card.md) done for the `diff` arm: that change made the Web client a consumer of the `terminal` render intent; this one makes it a consumer of the `diff` render intent, reusing the same four-layer shape.

## Decision

`DiffBlock` is a `ui-primitives` component that renders a file mutation as an inline diff surface, and both Web render sites for a write/edit call consume the diff render intent through it: the chat tool row's body and the details panel's Output section. `ui-tool/src/client/tool/models/diff-card-model.ts` is the single place that turns the snapshot's `callView`/`resultView` pair into the component's props, so the two sites cannot disagree about a change. It returns null — the generic path — whenever neither side declares `card: 'diff'`, including a `card` value this client version does not know, and whenever a settled call's result view is generic, which is how write/edit keep their execution errors on the generic path. The result side is authoritative once the call settles: the applied hunks replace the call-time diff derived from the arguments alone. A paging window that drops the call head still renders, because the result view carries the whole change.

The component shares the TUI's single-column framing, line-terminator rule, and distinct-path file count. Line classification differs: Web renders the complete old and new sides, while the TUI derives neutral context and exact changed rows when its bounded comparison completes and labels its whole-side fallback approximate.

- **Path grouping.** A new file opens a bold path header; a same-file second hunk (a scattered edit, or a `replace_all`) opens with a `⋯` gap instead of repeating the path. The TUI keeps a path header on every hunk, but both front ends count distinct paths in the `N file(s)` footer, so two hunks in one file read as `1 file`.
- **Whole-side change colors.** Every old-side line is `- ` on the error token and every new-side line is `+ ` on the success token, drawn verbatim with `white-space: pre` inside a horizontally scrolling box — a source line is read by its indentation, so it scrolls rather than folds. A create (`oldText: null`) has no removed side.
- **Height cap with an expand control.** A diff longer than `DEFAULT_DIFF_MAX_LINES` (16) shows `ceil(max/2)` head rows plus the remaining tail rows, with a button between reporting the hidden count. The split arithmetic matches `TerminalBlock` and the TUI's collapsed card, so a long diff's head and tail slices agree across front ends.
- **Line terminator.** A side's content splits on `\n` under the terminator rule `TerminalBlock` and the TUI use: empty text is zero lines (a full deletion's `newText`, a create's absent `oldText` side), a single trailing newline terminates its last line rather than adding a phantom empty one, and an interior blank line survives.
- **Footer and copy.** A dim `└ +A -R · N file(s)` footer reports the Web card's complete new- and old-side line counts. The TUI footer instead reports exact changed rows when available and marks a bounded whole-side fallback approximate; both use the same distinct-path file count. The copy control copies the prefixed Web diff text (path headers, `- `/`+ ` lines, the `⋯` gap), so a multi-file copy stays attributable.

Geometry, radius, and fonts mirror `CodeBlock`/`TerminalBlock` so a diff card, a terminal card, and a fenced block read as one family; `white-space: pre` plus horizontal scroll is the deliberate divergence. The copy control floats in the card's top-right corner rather than on a banner row of its own, because a banner carrying only a copy button drew an empty band above the first diff line — the TUI diff card has no banner either, only the footer.

The chat row renders the diff resident under its path-link summary, capped at `CHAT_DIFF_MAX_LINES` (8) against the panel's 16 — the same inline-output decision and the same in-flow-vs-reading-surface split recorded for the [terminal card](2026-07-28-web-terminal-card.md#inline-output-in-the-chat-row-reverses-a-stated-convention). A write/edit row is single-file, so its summary stays an openable path link AND its diff card expands; the two coexist because the card is not the path's args body.

## Alternatives considered

**A side-by-side (two-column) diff.** Rejected: it is denser but does not fit the narrow chat row, and the selected design matches the TUI's single-column unified form. A two-column details-panel mode remains separable from this card design.

**Git-style line-number gutters.** The `FileDiff` contract carries only `{ path, oldText, newText }` — `structuredPatch`'s hunk start lines are dropped in `diff.ts`, so no line number reaches the client. Rendering a numbered gutter needs a backend contract change (carry `oldStart`/`newStart`) and a matching TUI upgrade to stay consistent; deferred so this change stays a pure Web consumer of the existing contract.

**Reuse `CodeBlock`.** Rejected for the same reason the terminal card was: `CodeBlock` soft-wraps and has no per-line `+`/`-` role, no path headers, and no footer. The two share geometry and font tokens, which is the only part where one implementation is correct for both.

## Consequences

`DiffBlock` reads only the diff view's fields, so it stays a pure function of what the render intent carries — replay-safe like the presenters that produce the view. A UI without the diff capability still gets the bridge's generic fallback; nothing about the tool's result shape changed. No new runtime dependency: unlike the terminal card's `anser`, a diff needs no parser.

The multi-file arm of `DiffBlock` (one card, several path headers) has no shipped producer: `write`/`edit` each mutate one file per call, so a real card shows one file with one or more hunks. The arm is built and tested for a future multi-file mutation tool, not for a current consumer.

## Testing

`packages/client/ui-primitives/tests/diff-block.client.spec.tsx` pins the component: the create arm (added-only, no removed side), the edit arm (removed above added), the same-file `⋯` gap versus a new file's own header, the empty-diffs null render, the footer counts and their singular/plural, the head/tail cap with its `aria-expanded` toggle, and the copy control asserting the prefixed diff text on both the accepted and refused clipboard paths. Per-file 100%.

`packages/client/ui-tool/tests/diff-card.client.spec.tsx` pins the wiring at every render site: `diffCardModel`'s derivation and each of its null arms, the result hunks replacing the call-time diff, a window-truncated call still rendering from the result, the chat row's diff body, `FileMutationRow`'s resident card and its path link opening cwd-resolved through the host, its registration under both `write` and `edit`, and the panel's Output section.

The fixture (`packages/client/connection/src/client/fixture.ts`) carries three diff turns so a `?fixture` server and the per-package wiring suite exercise all three arms at both render sites: a single-hunk edit (turn 62, keyed `FileMutationRow`), a create/write (turn 63), and a multi-hunk edit (turn 67, the `⋯` gap between two scattered hunks in one file). The built-boot expected-output test (`apps/web/tests/built-boot.expected.e2e.ts`) is a boot-assembly smoke that asserts only that the graph mounts and reaches chat content (`data-sample="bash-global"`); by its own contract it carries no diff-behavior assertions, which the wiring suite owns.

## Related

- [Web terminal card](2026-07-28-web-terminal-card.md) — the same four-layer shape for the `terminal` arm; this note reuses its inline-output decision and its head/tail cap arithmetic.
- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) — the `card`-tagged vocabulary this consumes; the Web client is now a consumer of the `diff` arm too.
- [Web client architecture](../architecture/2026-07-19-gui-web-client-architecture.md) — the slot and snapshot layering the two render sites sit in.
