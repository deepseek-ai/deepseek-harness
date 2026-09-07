# Agent Note: Web result card — a structured render intent for web_search and web_fetch

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-web-result-card.zh.md)

## Problem

The `web_search` and `web_fetch` tools each declared a generic pending card (`presentCall`, `kind: 'search'`/`'fetch'`) but no `presentResult`, so a completed web call reached a UI only as the model-facing render text. For a web frontend that wants to render a citation list or a fetch summary, that text is lossy: `web_search`'s render collapses each source's `title`, `snippet`, and `publishedAt` into one free-text markdown line labelled by title OR hostname (`formatSearchOutput` in `packages/web/tool-web/src/search.ts`), so reparsing the render cannot recover the per-source fields; and `web_fetch`'s render carries `url` and `statusCode` only in a header line. The render-intent contract ([tagged union](../architecture/2026-07-02-tool-render-intent-union.md)) had no arm a web tool could declare to carry a structured result.

## Decision

Add one `card: 'web'` result arm to `ToolResultView` (`packages/core/tools/src/presentation.ts`), a union `WebResultView = WebSearchResultView | WebFetchResultView` discriminated by a `kind: 'search' | 'fetch'` field, plus a `WebSource` shape for one citeable source. Both tools now declare `presentResult`.

One tag with a `kind` discriminant, not two tags. Both calls are web retrieval and a web frontend renders them with one component family (a retrieval card whose body differs by kind), so a shared `card` keeps every card consumer's switch to one added arm and lets the frontend branch on `kind` inside it. Two tags would force every present and future consumer to add two arms for what is one visual family. The `kind` values match the two tools' existing generic call-view `kind`s, so a call and its result read as the same category.

`presentationMeta` carries what render text cannot. The structured result object a tool returns from `execute` does NOT reach a client over the wire — only the model-facing `render` text and, when declared, the `output.presentationMeta` JSON projected onto the `tool/result` event's `meta` do. For `web_search` the meta is the ONLY faithful route to `{url, title?, snippet?, publishedAt?}`: the render collapses those fields into one lossy free-text line, so a consumer cannot reparse them. For `web_fetch` the meta is a smaller but real gain: `url`/`statusCode` are recoverable from the deterministic `Fetched <url> (HTTP <n>)` header line, but `truncated` is the effective truncation — provider cap, pre-conversion source cut, or the deployment's `fetchMaxOutputChars` output cap — which a client cannot recompute because it does not know that cap. The fetch card and the model-facing text derive `truncated` from one shared `renderFetchOutput(result, maxOutputChars)` helper, so the card never disagrees with the footer the model saw. This mirrors the write/edit diff template (`packages/fs/tool-fs/src/diff.ts`): a `*MetaFromValue` projector feeds `output.presentationMeta`, and a `*MetaFromResult` narrower reads `result.meta` back with a defensive fallback to the generic card. `web_fetch`'s body is already markdown in the result content, so it is not duplicated into meta.

Neither result view carries a `content` copy. A UI that does not render the structured `web` card falls back to the raw `tool/result` content, the same input a generic card consumes. Copying that content into the view would duplicate up to `fetchMaxOutputChars` characters on the same delivered frame for no gain (the same rejection the meta section applies to the fetch body), so the views omit it and the fallback path renders the identical text. Each view sets its result-state `title` from the call args (`args.query` / `args.url`) so a window-truncated replay that dropped the call head still has a title, the way write/edit reset title at result time.

`presentResult` returns `undefined` (the generic card) on an error result and on absent or malformed `meta`, because presentation runs on replay of arbitrary logged results (possibly from an older schema) and must never throw. The narrowers validate every field defensively; an empty source list is valid meta, not malformed.

## Consequences

The frontend consumer is owned by the [web result card frontend note](2026-07-30-web-result-card-frontend.md): this producer change adds the contract arm and makes the two tools emit it, with no client-side rendering. Its one observable change is that the `web_search`/`web_fetch` `tool/result` events persist a `data.meta` payload (the `web-fetch` keyless snapshot was refreshed accordingly); model-facing render text and generic fallback content stay unchanged. The assembled-application transcript snapshot that exercises a `web` card belongs to the consumer change that renders it. Any `ToolResultView` consumer that switches exhaustively must add a `web` arm; a non-exhaustive consumer may use the raw-result fallback. Session Controller carries the event's typed `surfaceOp` without redeclaring card tags ([wire type](../../../../packages/api/session-controller/src/types.ts)), so the new view crosses the wire without a schema change.

A future web tool that wants this card declares `presentResult` returning a `card: 'web'` view with its own `kind`; adding a third `kind` is a union edit plus the frontend's branch, not a new card tag.

## Alternatives considered

**Two card tags (`web-search`, `web-fetch`).** Rejected: it doubles the arm count at every card consumer for one visual family, and the two shapes already share enough (a titled retrieval card with fallback content) that a `kind` discriminant expresses the difference without a second tag.

**Reparse the render text in `presentResult` instead of projecting meta.** Rejected for `web_search`: the render's source list is lossy (title-or-hostname label, snippet and date concatenated into free text), so reparsing cannot faithfully recover the structured fields. `presentationMeta` is the only route that preserves them.

**Carry the fetch body in meta, or copy the result content into either view.** Rejected: the body is already the model-facing markdown in the result content, and duplicating it into meta or into a view `content` field would double the persisted or delivered payload for no gain; a UI without the `web` capability falls back to the existing result content, which is the same text.

## Testing

`packages/web/tool-web/tests/tool-web.spec.ts` covers, per-file to the 100% gate: `searchMetaFromValue`/`fetchMetaFromValue` projection including omission of absent optional fields, and the fetch `truncated` projection agreeing with the render footer both when only the output cap cut the body and when nothing did; `searchMetaFromResult`/`fetchMetaFromResult` narrowing with a round-trip and every malformed-shape rejection (non-object, wrong field types, a malformed source entry) plus the empty-source-list accept; `presentSearchResult`/`presentFetchResult` typed views including the args-derived title, the absence of a `content` copy, the truncated signal, the error-result fallback, and the malformed-meta fallback; and two real-registry executions asserting the tool projects the meta onto `result.meta` and its registered `presentResult` derives the `card: 'web'` view.

## Related

- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) — the `card`-tagged vocabulary this extends with the `web` arm.
- [Web terminal card](2026-07-28-web-terminal-card.md) — the precedent that carried the bash `terminal` render intent to the browser; the [web result card frontend](2026-07-30-web-result-card-frontend.md) is its analogue for this arm.
