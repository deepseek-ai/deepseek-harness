# Agent Note: Web search source card scrolls instead of collapsing

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-03-web-search-source-scroll.zh.md)

## Problem

The `web_search` result card (`WebBlock`, `packages/client/ui-primitives/src/WebBlock.tsx`) rendered its source list with a head/tail collapse: past a `maxSources` count (16 in the details panel, 8 in the chat row via `CHAT_WEB_MAX_SOURCES`) it drew the first `ceil(max/2)` sources, an `… 其余 N 条来源` expand button, then the last `max - ceil(max/2)`, mirroring `TerminalBlock`'s output cap. A user reading the card saw `来源列表已截断` and assumed the frontend had dropped sources it was holding.

It had not. The seam (`capSources`, `packages/web/web/src/index.ts`) cuts each provider result to the tool's `searchMaxResults` bound (default 8); a multi-query call then deduplicates, interleaves, and caps the combined sources at the same bound. The final capped list feeds both the model-facing render text and the card's `presentationMeta`, so the card never holds more sources than the tool returned. The collapse was hiding sources the user was entitled to see in full — and, with the default bound at 8 and the panel cap at 16, it almost never even triggered, leaving only the `truncated` note with no way to reveal anything.

## Decision

`WebBlock`'s search arm renders every source it receives in one `<ol className={css.sources}>`, with no head/tail slicing, no expand button, and no `maxSources` prop. `.sources` (`WebBlock.module.css`) gets a fixed `max-height` and `overflow-y: auto`, so a list longer than the card height scrolls in place rather than growing the card or hiding rows. The height is a design constant of the card geometry, so it lives in CSS, not a plugin config field.

The model side remains capped at `searchMaxResults`: the seam caps each provider result, the multi-query consumer caps a combined list, and the `truncated` flag and its `来源列表已截断` indicator stay. The card draws the final tool source list in full and scrollable, instead of collapsing its middle.

That list is the one the model reads as long as nothing downstream of the tool rewrites the result content alone. A deployment mounting `dsh-spill-policy` breaks that correspondence for an oversized result: `tools/post-execute` replaces the model-facing `content` with a preview plus a spill locator and leaves `presentationMeta` whole, so the card still draws every source while the model reads a bounded excerpt. The card's contract is therefore the view it receives, not the model's context.

`CHAT_WEB_MAX_SOURCES` and the primitive's `DEFAULT_WEB_MAX_SOURCES` are removed: with scroll, the chat row and the details panel show the same full list, differentiated only by their container height. `<li value={ordinal}>` still pins each source's 1-based citation index; without the collapse gap the ordinals are now simply contiguous.

Making the list a scroll container also makes its `padding-left` a correctness constraint, not spacing. A scroll container clips inline-start overflow and offers no way to scroll it back, and `::marker` is right-aligned to the content edge, so a marker wider than the padding silently loses its leading digits — at the list's 20px the two-digit markers rendered as `0.` and `1.` where `10.` and `11.` belonged. `searchMaxResults` is an unbounded positive integer, so the padding is sized in `em` against the list's own font — the one a marker inherits — to hold a three-digit marker (`999. ` measures 2.35em in the app font stack) and keeps the gap the one-digit case already had.

## Alternatives considered

**Raise `searchMaxResults` (or make it unbounded) so more sources reach both the model and the card.** Rejected by the user: it changes model-side behavior (more sources into every request's context, more tokens) and widens the gap between what the model reads and what the card draws.

**Keep the head/tail collapse and add scroll only to the expanded region.** Rejected: two overlapping mechanisms for one concern. Once the whole list is always rendered, the collapse arithmetic, the expand/collapse state, and the button are dead weight; scroll alone bounds the height.

**Make the scroll height a plugin config field.** Rejected: the height bounds the card's on-screen geometry, not a deployment policy, so it belongs in `WebBlock.module.css` alongside the radius, surface, and margin that [the web result card frontend note](2026-07-30-web-result-card-frontend.md) already fixes there as this card's geometry.

## Consequences

Every source the tool returned is always in the DOM, so no source the view carries is hidden behind an interaction. The card's height is bounded regardless of source count, and a list taller than the container scrolls in place. The cost is that the scroll affordance depends on the platform's scrollbar rendering: an overlay-scrollbar system (macOS default) shows no persistent bar when the pointer is away, so a capped list relies on the `来源列表已截断` note plus a clipped last row to signal there is more. `WebSearchBlockProps`/`WebFetchBlockProps` lose their `maxSources` prop and the primitive loses `DEFAULT_WEB_MAX_SOURCES`, so any future caller renders the full list by construction rather than by passing a large cap.

## Testing

`packages/client/ui-primitives/tests/web-block.client.spec.tsx` drops the collapse cases (head/tail slice, expand-on-click, collapsed-tail numbering, expander-out-of-numbering, head-alone, default cap) and adds: a 30-source card renders all 30 `<li>` with no `[aria-expanded]` and no `<button>`, every `<ol>` child is a source `<li>`, and `<li value>` numbers 1..N contiguously. `packages/client/ui-tool/tests/web-card.client.spec.tsx` drops the `CHAT_WEB_MAX_SOURCES` cap assertion; the WebRow expansion test still asserts the card shows every source field. `packages/web/tool-web` independently pins the single- and multi-query model-side caps.

jsdom resolves no CSS Modules layout, so it reports `scrollHeight === clientHeight` for every element and cannot witness the scroll at all. The geometry is pinned in the assembled browser instead, by `apps/web/tests/web-search-round.e2e.ts`: its deterministic search double returns 6 results for each of two queries, each with a title, a citation snippet, and a date. The real composition observes both provider requests and pins the tool's round-robin combined cap — the shipped `searchMaxResults` keeps 8 sources representing both queries, the model-visible render text omits the 4 dropped URLs and includes `(Showing the first 8 sources. Refine the query for more.)`, and `meta.truncated` is true. A case after the aria golden then expands the `web_search` row and asserts on the card's `<ol>`: 8 `<li>`, no `<button>` anywhere in the card, the `来源列表已截断` indicator visible, and computed `max-height: 320px` with `overflow-y: auto` over a taller scroll body. A further case measures a `999. ` marker in the list's own inherited font and requires the computed `padding-left` to be at least that wide, so the marker room the scroll container cannot clip back is pinned against the widest marker rather than against one fixture's source count. Replay is a positional cursor over the fixture's embedded Assistant settlements, and the search double is a separate local endpoint the provider reaches by `fetch`.

## Related

- [Web result card](2026-07-30-web-result-card.md) — the `card: 'web'` render-intent arm and `presentationMeta` route this card consumes; the source of the final capped list.
- [Web result card frontend](2026-07-30-web-result-card-frontend.md) — owns `WebBlock`, the single `web-card-model` derivation, and the render sites that draw the card; this note replaces the source-list collapse it specified, and its other decisions (one component for both kinds, the http(s) link allowlist, the single derivation, the resident posture) stand.
