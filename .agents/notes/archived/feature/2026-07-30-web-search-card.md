# Agent Note: Web search card — the grep and glob render intent reaches the browser

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-web-search-card.zh.md)

## Problem

The `grep` and `glob` tools declare a result-time `card: 'search'` render intent ([search render card](2026-07-30-search-render-card.md)): a `SearchMatchesResultView` (`shape: 'matches'`) carrying grep's matches grouped by file, or a `SearchPathsResultView` (`shape: 'paths'`) carrying glob's flat path list, both with a `truncated`/`total` capping signal. That view already reaches the browser — host, connection, and runtime deliver it onto `ConversationSnapshot` as `resultView` — but the Web client ignored it: every non-terminal, non-diff tool result fell through to the generic card, which renders the model-facing text. A web frontend that wants an expandable per-file group of matches, or a scannable path list, had only the pre-formatted text.

This is the follow-up the search render card note names: that note owns the backend contract and its two producers; this note owns the web consumer.

## Decision

`SearchBlock` is a `ui-primitives` component that renders a completed search as either shape, and the Web render sites for a `grep`/`glob` call consume the search render intent through it. `ui-tool/src/client/tool/models/search-card-model.ts` is the single place that turns the snapshot's `resultView` into the component's props, so no render site re-derives the shape. It returns null — the generic path — whenever the result view is not a search card, including a still-running call (a search card is result-time only, so there is nothing before `execute`), a generic result a `grep`/`glob` failure or a nested `run_code` dispatch produces, a terminal result view, a `card` value this client version does not know, a `card: 'search'` view whose `shape` this version does not compile, and — because `shape` and the grouped/flat contents ride the same untrusted wire frame the host schema only string-checks — a known `shape` whose `files`/`paths` is missing or malformed (which would otherwise crash `SearchBlock` at `.reduce`/`.map`). The result-view discriminant is `shape` (not `kind`, which the backend reserves for the call view's icon-picking tag); `SearchBlock`'s own prop stays `kind`, mapped from `shape` in this derivation.

The asymmetry with the terminal card is deliberate and inherited from the backend contract: `terminalCardModel` reads both `callView` and `resultView` because a command, cwd, and description exist at call time; `searchCardModel` reads only `resultView` because a search's matches or paths exist only after execution. A running search row therefore shows its summary alone, with no card.

One component draws both shapes, discriminated by `kind`, because `grep` and `glob` are the same visual object — a search result. `SearchMatchesBlockProps` (`kind: 'matches'`) and `SearchPathsBlockProps` (`kind: 'paths'`) keep each shape's fields required rather than a single interface with everything optional. The component flattens whichever shape it holds into one list of render rows — a file header row plus its match rows for the matches shape, one path row per path for the paths shape — so the height cap counts a file header as one row exactly as a match line or a path, and the head/tail slice arithmetic is `TerminalBlock`'s (`ceil(max/2)` head, the remainder tail), so a long search result and a long command output cut at the same place across the two cards.

The component's contract:

- **Grouped matches, collapsible per file.** Each file is a header row (a bold path plus its match count, the whole row the collapse control) followed by its `lineNumber: line` rows. Collapsing a group drops its match rows from the flattened list and from the height cap's arithmetic, but never from the copy text.
- **Flat path list.** The paths shape renders one path per row, no headers.
- **A capped indicator.** When `truncated`, the banner summary folds the pre-cap total in — `显示 X / 共 N 处匹配 · K 个文件` for grep, `显示 X / 共 N 个路径` for glob — so the card never presents a capped page as the complete result. When not `truncated` the summary is a plain structural count (`{n} 处匹配 · {m} 个文件`, or `{n} 个路径`).
- **A recovery footer for a capped result.** The card holds only the retained page, but the locator to the rest — grep/glob's `Full … stored at: <locator>` footer — lives only in the raw `tool/result` content (the search view carries no result text; a UI without a card falls back to that raw content), not in the structured matches/paths. Because every render site replaces the raw result with the card, `searchCardModel` surfaces the block's own flattened result text as `SearchCardModel.recovery` when (and only when) the result was capped, and each render site draws it below the card. Without this the one path to the dropped rows would vanish from the UI; an uncapped result carries every row, so its raw text adds nothing and is dropped.
- **No soft wrapping.** Result rows are `white-space: pre` inside a horizontally scrolling box, so a long match line or a deep path scrolls sideways rather than folding.
- **Height cap with an expand control.** More than `DEFAULT_SEARCH_MAX_LINES` (16) rows shows a head/tail slice with a button reporting the hidden count, the same shape and arithmetic as `TerminalBlock`.
- **Copy.** The copy control writes the whole structured result — every file and match, or every path — regardless of the height cap or which groups are collapsed, so the clipboard carries the result rather than what the card happens to be showing.

Geometry, radius, and fonts mirror `CodeBlock` and `TerminalBlock`, so a search card reads as one family with them; `white-space: pre` plus horizontal scroll is the shared deliberate divergence.

### Render sites

Three sites consume the derivation, mirroring the terminal card's placement exactly:

- **The keyed `SearchRow`** (`toolviews/search-row.tsx`) registers ONE component under both `grep` and `glob` in the `tool.call.toolview` keyed hole, and renders the card RESIDENT under the summary row, capped at `CHAT_SEARCH_MAX_LINES` (8) — the same posture `BashRow` takes for its terminal card. Both tool names get the same row because the derived `kind` decides the shape, so a second component would duplicate it. A capped result's recovery footer sits below the card. Because the keyed row owns this render slot, a settled call with no search card — an errored search (grep/glob emit no result view on error), a successful nested `run_code` sub-dispatch (the backend computes no `presentationMeta`, so `resultView` is null), or a legacy generic result — would otherwise show only its summary with its content lost; the row surfaces that model-facing text as a fallback body, keyed on `search === null && settled` rather than on the error state alone. (This resident posture matches the terminal/diff cards; the [unified expand-and-inspect note](2026-07-30-web-tool-row-unified-expand-and-inspect.md) owns the whole-row collapse/expand interaction that flipped all resident cards at once.)
- **The generic fallback** (`chat/GenericToolCard` → `chat/ToolRow`) threads the derived model as an expand-gated body, the same arm `terminal` uses: a `grep`/`glob` result with no keyed row (none in the shipped app, since both are registered) still renders its card, with the recovery footer, behind the row's expand toggle.
- **The details panel** (`skeleton/DetailsPanel`) renders the card at the primitive's own full height in the Output section, with the recovery footer below it, keeping the JSON Input section.

`CHAT_SEARCH_MAX_LINES` (8) is the row cap, half the primitive's default the panel keeps, for the same reason as `CHAT_TERMINAL_MAX_LINES`: the chat flow is a summary surface read across many calls, the panel is the single-call reading surface.

## Alternatives considered

**Two card components, one per tool.** Rejected: `grep` and `glob` are the same visual object discriminated only by `kind`, so two components would duplicate the banner, the height cap, the copy control, and the no-wrap geometry. One component switching on `kind` is what the backend's single `card: 'search'` view is for.

**A `SearchCallView` so the row renders a card while the search runs.** Rejected: the backend contract deliberately has no call-time search view — a search has no matches or paths before `execute`. The running row shows its summary alone, and `searchCardModel` returns null for a running block, which is faithful to what exists.

**Reuse `TerminalBlock` or `CodeBlock`.** Rejected: neither models per-file collapsible groups or a folded capped-result summary, and both would need the grouped-matches shape bolted on. The three blocks share their geometry and font tokens instead, which is the only part where one implementation is correct for all.

## Consequences

`SearchBlock` reads only the search view's fields, so it stays a pure function of what the render intent carries — no session lookups, replay-safe like the presenters that produce the view. A UI without the search capability still gets the bridge's fenced fallback; nothing about the tool's result shape changed. Extending `ToolRow` with a `search` body prop adds one arm beside `terminal`; a call carries at most one card kind, so the two are never both present on a row.

## Testing

`packages/client/ui-primitives/tests/search-block.client.spec.tsx` pins the component at per-file 100%: both kinds, the folded pre-cap total in the summary, the empty arm, per-file collapse/re-expand without touching neighbours, a file header counting as one capped row alongside its matches, the tail slice restoring its owning file header when the cut falls mid-file, the head/tail cap and its expand control across both shapes and the no-tail and default-cap edges, and the copy control writing the whole structured result on the accepted and refused clipboard paths.

`packages/client/ui-tool/tests/search-card.client.spec.tsx` pins the wiring at every render site: `searchCardModel`'s derivation for both kinds, the truncation signal, the replacement title, the recovery text surfaced only when capped, each null arm (running, no views, generic, terminal, unknown card, an uncompiled `kind`, and a known kind with a missing/malformed shape); the chat row's expand-gated matches and paths bodies through `GenericToolCard` (with the recovery footer) against the non-search args-JSON body; `SearchRow`'s resident card for both kinds, its recovery footer, its fallback body for both an errored search and a settled cardless result, its agreement with the summary row's run state, the replacement-title precedence, and the keyed registration under both `grep` and `glob` with one component; and the details panel's Output section for both kinds (with the recovery footer) against the non-search flattened form. `packages/client/ui-tool/src/*` sits on the coverage exclude list, so this file is written against no gate pressure. `packages/client/connection/src/client/fixture.ts` gains a `grep` turn emitting `kind: 'matches'` (three files, twelve rows over the row cap, `truncated` with a spill-recovery footer, so it exercises the head/tail cap and the recovery footer in the assembled snapshot) and a `glob` turn emitting `kind: 'paths'`, both driving the built-boot snapshot and the live `?fixture` server. `apps/web/tests/search-card.expected.e2e.ts` is the assembled-output check the repo contract asks for: it boots the real built `client.js` bundles through the keyless fixture transport, opens the fixture session, and pins the grep card's assembled shape — kind, truncation summary, the head/tail slice, and its expand control — under `apps/web/tests/expected/search-card/`, so a broken SearchRow registration or a dropped card fails a golden the built-boot smoke (boot-only by contract) cannot.

## Related

- [Search render intent — grep and glob emit a structured search card](2026-07-30-search-render-card.md) — the backend contract and its two producers; this is its named web-consumer follow-up.
- [Web terminal card](2026-07-28-web-terminal-card.md) — the precedent this mirrors: a tool's render intent reaches the browser through a `ui-primitives` block, a single `contract/*-card-model.ts` derivation, and the same three render sites.
- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) — the `card`-tagged vocabulary both cards consume.
