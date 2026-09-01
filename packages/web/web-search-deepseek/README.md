---
description: "The DeepSeek-backed search provider for ctx.web: how deployments mount native DeepSeek web search through the Anthropic-compatible Messages API, with per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-deepseek

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-deepseek`, the harness searches the web through DeepSeek's native search using an existing `DEEPSEEK_API_KEY`. Choose it when a deployment wants DeepSeek native search and accepts that one search costs a full model turn in latency and tokens, because DeepSeek exposes no dedicated search endpoint. Results come from the structured search blocks DeepSeek returns, never from scraping text out of a reply. A missing credential fails the call with a structured error; a response without a search-result block fails loudly rather than degrading. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `deepseek-official` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: deepseek-official`.

### When to choose it

Choose this backend when a deployment wants DeepSeek's native server-side web search and already holds a `DEEPSEEK_API_KEY` — the provider reuses that credential reference. One search is heavier than a dedicated retrieval endpoint: DeepSeek runs the search inside a full model turn, so expect one Messages call's latency and generated tokens per search, with up to `maxUses` server-side searches per request. Avoid it when per-search cost or latency dominates.

### Minimal configuration

Load the web service and the provider; the key resolves from `ctx.credentials` when that service is mounted, otherwise from the process environment. The search endpoint uses the Anthropic-compatible base (`https://api.deepseek.com/anthropic/v1`), distinct from the chat-completions base the LLM adapter uses — never reuse `$DEEPSEEK_BASE_URL`.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://gateway.internal/anthropic/v1
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal DeepSeek API key; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that service is absent. A missing value fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Anthropic-compatible endpoint base; `/messages` is appended. Falls back to `$DEEPSEEK_SEARCH_BASE_URL`; an unparseable value makes the provider unavailable |
| `model` | `deepseek-v4-flash` | Anthropic-format model name |
| `apiVersion` | `2023-06-01` | `anthropic-version` header value |
| `maxTokens` | `4096` | Positive-integer upper bound on generated tokens for the Messages request |
| `maxUses` | `5` | Positive-integer maximum `web_search` server-tool uses per request |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-deepseek) is the exhaustive source for every accepted field and its JSDoc. The entry above is the base layer of the provider's Settings section; a user layer over it reaches the next search, because the provider projects the section per call rather than capturing it at registration.

### What a search returns

`content` is always omitted: DeepSeek's provider prose is not trusted as an answer. `sources[]` comes from `web_search_result` items inside `web_search_tool_result` blocks — `url`, `title`, and `publishedAt` from `page_age` — with snippets joined from URL-keyed `cited_text` entries where an excerpt exists. Results are deduplicated by URL, and because DeepSeek exposes no result-count knob, the service enforces `maxResults` by truncating and flagging.

### Request logging

A search running under an initiating agent appends the log-only `web/deepseek-search-llm-request` session event immediately before dispatch. It carries the resolved endpoint, API version, and the exact secret-free JSON body sent to DeepSeek; headers and credentials are excluded. Credential failures and cancellations before dispatch create no event, while later HTTP or response failures leave the attempted request durable.

### Failures and recovery

Failures throw `WebError` with a machine-routable code: a missing credential is `WEB_PROVIDER_CREDENTIAL_MISSING`, caller cancellation is `WEB_ABORTED`, and provider or transport failures — including a response with no `web_search_tool_result` block — are `WEB_PROVIDER_ERROR`. HTTP redirects are rejected before the `Location` target is contacted. Every failure after dispatch names the resolved search endpoint and explains that search endpoint configuration is separate from chat. If the endpoint is unintended, the message tells the conversation model to guide the user to the Endpoint field under Settings > Plugins > Plugin configuration > Web search and save the change. When that page is unavailable, it names `DEEPSEEK_SEARCH_BASE_URL` and `web-search-deepseek.baseURL` as deployment configuration alternatives. The model must not choose or change the endpoint. The model-facing `web_search` tool surfaces this text under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on two commitments:

- **Structured blocks only.** DeepSeek runs the search server-side and returns structured `web_search_tool_result` blocks; the provider parses those blocks and never scrapes URLs out of model prose. In strict mode, a response with no such block throws `WEB_PROVIDER_ERROR` instead of degrading.
- **One credential, resolved per search.** The provider reuses the `DEEPSEEK_API_KEY` reference (no new secret) but not `$DEEPSEEK_BASE_URL`, because search speaks the Anthropic-compatible Messages API. A mounted credentials service is authoritative; without one the provider falls back to the launching process environment. Resolving per call means a key stored or rotated in the Web Models page reaches the next search without a restart.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, Settings section installation, per-search option projection |
| [`src/provider.ts`](src/provider.ts) | The `DeepSeekSearchProvider`: Messages request dispatch, block parsing, citation joining, credential resolution |
| [`src/types.ts`](src/types.ts) | Anthropic wire types for the search response |
| — | No runtime invariant companion is published; the package emits a pre-dispatch log event but owns no later authoritative dispatch event to relate it to. Exact envelope equality is pinned at the provider boundary instead. |

### Request flow

Each search projects the current Settings section into provider options — endpoint, model, key reference, limits — then resolves the credential reference through `ctx.credentials` (or the environment), appends the log-only session event, and dispatches the Messages request with the native `web_search` server tool. The response's `web_search_tool_result` blocks become `sources[]`; `cited_text` entries from text blocks are joined to their URLs as snippets; results are deduplicated by URL; and the service enforces the requested source bound on the way back.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the six-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-deepseek) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary DeepSeek search request

#### What the model sees

A separate DeepSeek model receives exactly `Perform a web search for the query: <query>` as its user text and one native `web_search` server-tool definition. This request is not part of the conversation model's context.

#### Token effect

Separate provider input and output tokens are incurred for each search; `maxTokens` caps generated output and `maxUses` caps native search uses.

#### KV Cache effect

Independent of the conversation request cache. The auxiliary instruction and native tool definition can form a stable prefix, but each changed query or model route prevents reuse from its first difference.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees deduplicated URLs, titles, dates, and citation snippets from structured search blocks; provider prose is not trusted as an answer. This provider's exact failures include the actionable missing-credential message, `DeepSeek search credential resolution failed: <error>`, and `DeepSeek search aborted`. Request, HTTP, native-search, and response-body failures append the resolved endpoint and the conditional configuration instruction described above. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Result tokens scale with returned sources and snippets, then the service enforces the requested source bound.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is expensive or incomplete. They are current package constraints.

- **One search costs a full Messages model turn** — latency plus generated tokens, with up to `maxUses` server-side searches; DeepSeek exposes no dedicated retrieval endpoint.
- **Dynamic credential availability resolves inside the operation** — the synchronous availability check can establish that a resolver exists but cannot query an asynchronous credential store, so a selected keyless provider fails the search with `WEB_PROVIDER_CREDENTIAL_MISSING`; the stable `web_search` schema stays registered.
- **Over-returned sources still cost tokens** — with no result-count knob on the wire, `maxResults` is enforced only post-hoc by service truncation.
- **Uncited results carry no `snippet`** — a source gains one only when a text-block citation (`cited_text`) matches its URL.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: dedicated retrieval endpoint

A native DeepSeek search endpoint that avoids the full model turn would remove the dominant cost; until DeepSeek exposes one, this provider stays a Messages-call adapter.

</details>
