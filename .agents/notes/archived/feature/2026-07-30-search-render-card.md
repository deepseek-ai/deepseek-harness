# Agent Note: Search render intent — grep and glob emit a structured search card

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-search-render-card.zh.md)

## Problem

`grep` and `glob` return structured canonical values — `grep` a flat `{ matches: [{ path, lineNumber, line }] }`, `glob` a `{ paths: string[] }` — but every UI only ever saw their model-facing render text: `grep` groups its matches under file headers with `Line N:` rows, `glob` prints a newline-joined path list, and both append a spill footer when the inline cap (`grepMaxMatches`, default 250; `globMaxResults`, default 100) drops later results to a spill file. A web frontend that wants to render a search result as an expandable per-file group of matches, or as a selectable path list, had to re-parse that text. Both tools already declared a call-time [render intent](../architecture/2026-07-02-tool-render-intent-union.md) (`GenericCallView`, `kind: 'search'`) but no result-time view, so the completed call fell back to the generic card that renders the raw text.

The structured canonical value does not cross the wire: only the model-facing render text and, when a tool declares `output.presentationMeta`, a JSON metadata payload reach the client, threaded through the `tool/result` event ([canonical-output contract](../architecture/2026-07-20-canonical-tool-output-contract.md)). A result-time view carrying structured data therefore has to project that data into `presentationMeta` and read it back in `presentResult` — the same path `write`/`edit` use for their diff cards.

## Decision

`packages/core/tools/src/presentation.ts` adds `card: 'search'` to the `ToolResultView` union as `SearchResultView`, a `shape`-discriminated view that expresses both tools' shapes: `SearchMatchesResultView` (`shape: 'matches'`) carries `grep`'s matches grouped by file as `files: { path, matches: { lineNumber, line }[] }[]`, and `SearchPathsResultView` (`shape: 'paths'`) carries `glob`'s flat `paths: string[]`. Both carry `truncated: boolean` and `total: number`.

The discriminant is `shape`, not `kind`, deliberately: the same presentation module already gives `GenericCallView` a `kind: ToolCallKind` field whose values include `'search'` (the icon category). A bridge holding a `ToolCallView | ToolResultView` would see two `kind` fields with two meanings; `shape` for the result variant keeps the two apart.

One view with two shapes rather than two cards, because both tools are the same visual object — a search result — and a web consumer switches on one `card` value, then on `shape` for the row layout. The discriminated `shape` keeps each variant's fields non-optional (a matches view always has `files`, a paths view always has `paths`) instead of a single interface where every shape-specific field is optional.

The view carries **no** result text. Attaching the model-facing `result.content` would be a no-op — consumer fallbacks already read the raw `tool/result` content — and would serialize the whole search text a second time into the persisted view. The view is the structured shape only; a UI without a search card falls back to the raw result content.

The card tag is result-time only. A search call stays a `GenericCallView` (`kind: 'search'`): the pending state has no matches or paths to show, so there is nothing a `SearchCallView` would carry that the generic title does not. This is the asymmetry with the terminal card, whose call view carries the command, cwd, and description that exist before execution; a search's structured content exists only after `execute`.

`packages/fs/tool-fs-search/src/presentation.ts` owns the projection and the narrowing. `grepSearchMeta`/`globSearchMeta` project the canonical value into a `SearchMeta` payload each tool declares as `output.presentationMeta`; `presentGrepResult`/`presentGlobResult` read `result.meta` back through `searchViewFromMeta`. They consume the SAME retained result the model-facing render consumes — `retainGrepMatches`/`retainGlobPaths` in `search-core.ts` run the inline cap and per-line preview budget ONCE, and both the render and the projection take that outcome — so text and card never disagree about which results survived, and there is no second retention pass. `total` is every result the search found (before capping); `truncated` is set when the cap dropped results. This is the truncation-honesty point: the model saw a capped inline result plus a spill footer, so the card must not present the retained page as the complete result — a UI reads `truncated`/`total` to show a capped indicator rather than claiming completeness the model never had.

**The meta has its own byte budget.** The inline cap bounds the item COUNT, but the retained matches of a broad search (hundreds of long lines) can still serialize to hundreds of kilobytes, and `meta` is persisted with the session log and re-sent on every request. A deployment's final output budget (`dsh-spill-policy`, `maxInlineBytes`) only shrinks a result's `content` — `PostToolDecision` has no `meta` channel — so the projection owns keeping `meta` bounded. `capMetaBytes` drops trailing file groups / paths until the serialized meta fits `searchMetaMaxBytes` (config, default 64 KiB) and marks the result `truncated`. A single item too large to fit on its own is kept: the invariant is a bounded payload wherever droppable, never an empty card that hides a real result.

`searchViewFromMeta` narrows the opaque `meta` defensively and returns `undefined` on any malformed or absent payload, so a presenter run on an older or hand-edited replayed log falls back to the generic card instead of throwing. It DOES accept a zero-result payload (`files: []` / `paths: []`) as a valid empty card — this is a deliberate departure from the mirrored `diffsFromMeta`, which rejects empty `diffs`, because a zero-match grep is a legitimate result a UI shows as "no matches", not an absent projection. `presentResult` returns `undefined` for a failed result, for absent meta (a nested `run_code` dispatch computes no `presentationMeta`), and for the other tool's meta shape (each presenter narrows to its own `shape`).

The `SearchMeta` member shapes are object-literal `type` aliases, not the `SearchFileMatches`/`SearchLineMatch` interfaces the view exposes, because only a type alias is assignable to the `JsonValue` index signature `presentationMeta` returns; the two are structurally identical, so the projected value still reads back as a `SearchResultView`.

A consumer without a dedicated `search` arm falls back to the same generic body and reads the model-facing text from the raw result. Because the search view carries no `content` of its own and grep/glob previously returned a generic card, that fallback stays byte-identical to the pre-search-card path. The frontend that renders the structured `files`/`paths` shape is independent of this backend contract and its two producers.

## Alternatives considered

**A single flat `SearchResultView` interface with optional `files?` and `paths?`.** Rejected: it makes both shape-specific fields optional on every value and lets a malformed view carry both or neither. The `shape` discriminant keeps each variant's fields required and lets a consumer switch exhaustively.

**Reuse `kind` as the shape discriminant.** Rejected: `kind` already means `ToolCallKind` (the icon category, whose values include `'search'`) on the call view in the same module. A second `kind` with a different meaning on the result view collides for any bridge holding both.

**Attach the model-facing text as the view's `content`.** Rejected: a no-op for every current consumer and a second serialization of the whole search text into the persisted view. The view is the structured shape; text fallback reads the raw result content.

**A meta channel on `PostToolDecision` so `dsh-spill-policy` bounds `meta` like it bounds `content`.** Rejected here: it changes the core tool decision contract and the spill-policy plugin for one tool's payload. The projection bounding its own `meta` at a config byte cap is self-contained and keeps the seam unchanged.

**A call-time `SearchCallView` mirroring the terminal card's both-sides symmetry.** Rejected: a search call has no matches or paths before `execute`, so the view would carry only the title the `GenericCallView` already carries.

## Consequences

`grep` and `glob` now compute `presentationMeta` on every non-nested successful call, a bounded projection over the already-retained matches or paths — the same retention outcome the render consumes, so there is no second retention pass and no doubled search text on the wire. The serialized meta is bounded by `searchMetaMaxBytes`, so a broad search no longer persists an unbounded structured copy into the session log.

A UI without a search card renders the raw `tool/result` content, so no consumer regresses. A consumer that renders the structured shape reads `truncated`/`total` and the per-file groups; because the view carries only the retained, byte-bounded page, a UI wanting the complete result follows the spill locator in the model-facing text, exactly as the model does.

## Testing

`packages/fs/tool-fs-search/tests/presentation.spec.ts` pins the pure layer: `groupMatchesByFile`'s first-seen file order; `grepSearchMeta`/`globSearchMeta` projection over a shared retention outcome with `total` reporting the pre-cap count and `truncated` carried through; the per-line preview budget the retention pass applied; the serialized-meta byte cap dropping trailing groups/paths while keeping a single oversized item; and `searchViewFromMeta`'s narrowing of both good shapes, the zero-result empty card, and every malformed case (non-object/array meta, missing or mistyped `truncated`/`total`, unknown `shape`, malformed `files` entries, non-string `paths`). `packages/fs/tool-fs-search/tests/tools.spec.ts` pins the wiring through the real tool registry: a capped `grep`/`glob` execute produces the `SearchMeta` on `result.meta` and `presentResult` builds the search view (no `content`), a nested `run_code` dispatch computes no meta so `presentResult` falls back, and a failed or cross-shape or malformed result falls back to the generic card. Per-file 100% coverage holds over the search package `src`.

## Related

- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) — the `card`-tagged vocabulary this extends with the `search` result tag.
- [Canonical tool output contract](../architecture/2026-07-20-canonical-tool-output-contract.md) — the value/render/`presentationMeta` split this projection rides; the structured value stays execution-local, the card rides `meta`.
- [Web terminal card](2026-07-28-web-terminal-card.md) — the precedent this mirrors on the backend: a tool projects its result into `presentationMeta` and a `presentResult` view; the search card's web consumer is the analogous follow-up.
