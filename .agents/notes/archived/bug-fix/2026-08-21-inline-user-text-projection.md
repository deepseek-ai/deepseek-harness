# Agent Note: Sent user text projects inline, and queue rows fold wire references

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-inline-user-text-projection.zh.md)

## Problem

Two display gaps in sent user text, both older than the Lexical composer. The user-bubble decorator (`projectUserText`, then private to `MessageItem`) split one message into plain runs and reference chips, but rendered every plain run through the block-level `MessageText` div — so a decorated single-line message broke into one line per run, and the single space between two adjacent tokens rendered as a whole blank line. Separately, the queue dock's read-only row printed `row.preview` verbatim, so a queued message carrying a chip showed the wire session form `@[查看并分析图片](dsh-session:InNlc3Npb24t…)` — the model-facing text, unreadable as a preview. The logged model text was correct in both cases (verified against the session log bytes); both defects were presentation only.

## Decision

One shared inline projection, `reference/user-text.tsx`, owns the display of sent user text and is consumed by the bubble and the queue row:

- **Everything inline.** Plain runs render as `span`s; the block-level `MessageText` leaves the path entirely. White-space policy stays with the consumer: the bubble declares `pre-wrap` (real newlines survive), the queue preview keeps its `nowrap`/ellipsis single line — the shared spans pin neither.
- **Wire session forms fold.** A new highest-precedence rule folds `@[label](dsh-session:…)` to a session chip showing the label (the source text stays on `title`). The existing rules — recall-associated exact labels, then bare `/name` / `@name` tokens by shape — follow at their old precedence, so the fold also shields the URI from the bare-token scan that would otherwise misread it as a file path.
- **Queue edit stays literal.** The row's edit field exposes `row.text` unchanged: the user edits exactly what will be sent, and folding an editable surface would detach the visible text from the durable one.

`queue-actions.e2e` locators moved from `getByText(…).locator('..')` to row-container matching (`li` with `hasText`): the projection adds one span layer, so a parent hop from the matched text no longer lands on the row.

## Alternatives considered

- **Carry a display text beside the queued model text**: rejected — it adds a wire/session field for a presentation concern and violates the single-truth rule; folding at render needs no new state.
- **Fold inside the editor field too**: rejected — the edit target is the literal sent text; a folded editable view would let the user "edit" text that is not what gets sent.
- **Fix only the bubble's blank line with CSS** (collapse empty runs): rejected — the runs were block-level by construction, and the queue gap needed the shared projection anyway.

## Consequences

- A decorated single-line message renders on one line; the bubble in the field report dropped from four visual lines (one blank) to its natural wrapped height.
- Queue previews read as the composer showed them: label chips instead of `dsh-session:` URIs; the wire form also folds in the bubble if it ever reaches durable text.
- `MessageItem` and `QueueDock` share one decoration vocabulary and stylesheet (`user-text.module.css`); the chip styles left `MessageItem.module.css`.
- Tests: `user-text.client.spec` pins the inline guarantee (zero `div`s, whitespace-preserving runs) and every fold rule; the chat-view literal-text matcher followed the element change.
