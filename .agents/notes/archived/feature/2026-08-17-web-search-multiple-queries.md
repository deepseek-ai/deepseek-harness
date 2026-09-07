# Agent Note: web_search accepts multiple queries in one call

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-17-web-search-multiple-queries.zh.md)

## Problem

The model-facing `web_search` tool accepted only one `query`. In deployments where an internal search backend was also exposed as MCP, models preferred the MCP search tool because it could take multiple keywords in one call, and they often followed a native `web_search` with a second MCP search when the first result felt insufficient.

## Decision

`web_search` accepts one required `queries` string array. A one-item array performs a single search. `searchMaxQueries` bounds the array and provider fan-out, defaults to four, and appears in the system-prompt guidance and tool descriptions. Validation rejects an oversized array before any provider call starts, then exact duplicate strings are removed while preserving their first position.

When `queries` has multiple distinct entries, `dsh-tool-web` runs them concurrently through `ctx.web.search`, labels provider answers with their originating query, and deduplicates sources by URL. It takes one source at each rank from every query before advancing to the next rank, then caps the combined list to `searchMaxResults`; this prevents one query's lower-ranked sources from displacing every source from later queries. If any search fails, the tool aborts its siblings, waits for every started search to settle, discards successful results, and returns the first failure. A one-item array returns the provider's result without multi-query formatting.

The multi-query orchestration lives in the tool consumer, not in the web seam or providers, because `WebSearchProvider.search` remains a single-query contract and the seam stays provider-neutral.

## Alternatives considered

**Rely on the existing parallel tool-call support.** Rejected: the model still sees a one-query schema and must decide to emit multiple `web_search` calls, which is exactly the friction that pushed it toward the MCP interface.

**Accept both `query` and `queries`.** Rejected: two optional fields make the model choose between equivalent representations and move the required exactly-one rule into prose and runtime validation. One required array represents both one and many searches with fewer invalid states.

**Add a multi-query request type to `WebSearchRequest`.** Rejected: providers are single-query backends, and changing the shared seam would force every provider to implement a feature only the model-facing consumer needs.

**Accept an unbounded `queries` array.** Rejected: one model action could start an arbitrary number of provider requests and concatenate an arbitrary number of provider answers. A deployment-owned bound keeps the model schema focused on search input while controlling cost and output growth.

**Add an overall native-search budget to `WebSearchRequest`.** Rejected: the generic seam cannot count provider-internal search units without leaking one provider's mechanism or accepting a limit that other providers cannot enforce. Deployments combine the consumer-owned `searchMaxQueries` bound with provider-owned controls such as `maxUses`.

## Consequences

Models pass one required `queries` array for every native `web_search` call and can batch several distinct searches without switching to MCP search. The default query cap of four matches Codex `web.run`'s model-facing batch size while bounding concurrent provider calls; deployments can choose another positive integer independently of the source cap. Exact duplicate strings consume the input-array bound but cause only one provider call. Combined sources remain bounded by `searchMaxResults` and preserve each query's result ranking through round-robin merge. Provider answers in a multi-query result are prefixed with `### <query>` headings so the model can tell which answer came from which search.

Multi-query failure is all-or-nothing: a successful provider result is discarded if another query fails, and the call does not return until sibling cancellation reaches quiescence. `searchMaxQueries` and provider-owned controls are independently configurable and together form the search budget. A provider may perform several native searches inside one `ctx.web.search` call, so a model-backed provider with its own `maxUses` can permit up to `searchMaxQueries × maxUses` native searches; `searchMaxResults` bounds only the combined sources returned to the caller. The provider-neutral seam deliberately does not define an overall native-search counter.

The real Web composition snapshot issues one `queries` call through the DeepSeek search provider, observes two auxiliary provider requests, and pins the round-robin combined result, durable metadata, and joined search-card title. Package tests separately prove overlap before the first provider promise settles, query-cap rejection before provider dispatch, exact-query and source deduplication, uneven result exhaustion, truncation, caller cancellation propagation, and batch quiescence after failure.
