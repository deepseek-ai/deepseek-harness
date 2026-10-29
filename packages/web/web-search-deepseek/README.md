---
description: "The DeepSeek-backed search provider for ctx.web: how deployments mount native DeepSeek web search through the Anthropic-compatible Messages API, with per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-deepseek

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-deepseek`, the harness searches the web through DeepSeek's native search using the DeepSeek account sign-in or an existing `DEEPSEEK_API_KEY`. Choose it when a deployment wants DeepSeek native search and accepts that one search costs a full model turn in latency and tokens; the DeepSeek Search and Fetch APIs in [dsh-web-deepseek-api](../web-deepseek-api/README.md) retrieve without one. Results come from DeepSeek's structured search blocks, never from reply text. It is not ready for a model request without a credential, so `dsh-tool-web` withholds `web_search` from that request; a call that still arrives, or a response without a search-result block, fails with a structured error.

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

Choose this backend when a deployment wants DeepSeek's native server-side web search and its users either sign in to a DeepSeek account or hold a `DEEPSEEK_API_KEY` — the provider reuses those credentials as [Authentication](#authentication) describes. One search is heavier than a dedicated retrieval endpoint: DeepSeek runs the search inside a full model turn, so expect one Messages call's latency and generated tokens per search, with up to `maxUses` server-side searches per request. Avoid it when per-search cost or latency dominates.

### Minimal configuration

Load the web service and the provider; the key resolves from `ctx.credentials` when that service is mounted, otherwise from the process environment. The auxiliary search call has its own endpoint setting and uses the Anthropic-compatible base `https://api.deepseek.com/anthropic/v1`, with `/messages` appended. It reads `$DEEPSEEK_SEARCH_BASE_URL`, independently of the conversation adapter’s `$DEEPSEEK_BASE_URL`.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://gateway.internal/anthropic/v1
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal DeepSeek API key; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins over `apiKeyEnv`; an account token wins over both |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that service is absent. A search that needs an API key and finds none fails as `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Anthropic-compatible endpoint base; `/messages` is appended. Falls back to `$DEEPSEEK_SEARCH_BASE_URL`; an unparseable value makes the provider unavailable |
| `model` | `deepseek-v4-flash` | Anthropic-format model name |
| `apiVersion` | `2023-06-01` | `anthropic-version` header value |
| `maxTokens` | `4096` | Positive-integer upper bound on generated tokens for the Messages request |
| `maxUses` | `5` | Positive-integer maximum `web_search` server-tool uses per request |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-deepseek) lists every accepted field. Each search captures options from the live Config references.

<a id="authentication"></a>
### Authentication

A search authenticates with the DeepSeek account when the latest `request/context` event of the initiating Session names the `deepseek-account` provider route and `ctx.deepseekAccount` resolves a token for the search endpoint. The account service resolves one only while signed in and only for its deployment-configured inference origin, `https://api.deepseek.com` by default. That search sends only `x-dsh-auth-token`, even when an API key is configured. Every other search, including a call without an initiating Session and a search whose endpoint has another origin, sends the API key as both `x-api-key` and `Authorization: Bearer`. An HTTP 401 response to an account-authenticated search fails as `WEB_PROVIDER_ERROR` with sign-in guidance instead of endpoint guidance, and leaves the account signed in.

The provider's `ready()` answers whether the search a model request would make has a credential, on any model route: the request's route is `deepseek-account` and `ctx.deepseekAccount` resolves a token for the configured search endpoint, or a literal `apiKey` is set or `ctx.credentials.describe` reports the `apiKeyEnv` reference configured (without that service, the process environment must carry it). It checks them in the order a search resolves them, and a failed account-token or credential-store read answers false, because the search fails on that read instead of trying the next credential. While this provider is the selected search provider, [`dsh-tool-web`](../tool-web/README.md#search-readiness) withholds `web_search` and its prompt guidance from each request for which it answers false. Only presence is checked: a wrong key, or an endpoint that does not serve the native `web_search_20250305` server tool, counts as ready and fails each call. A call that still arrives resolves credentials when it runs.

### What a search returns

`content` is always omitted: DeepSeek's provider prose is not trusted as an answer. `sources[]` comes from `web_search_result` items inside `web_search_tool_result` blocks — `url` and `title` directly, and `publishedAt` from `page_age` — with snippets joined from URL-keyed `cited_text` entries where an excerpt exists. Results are deduplicated by URL, and because DeepSeek exposes no result-count knob, the service enforces `maxResults` by truncating and flagging.

### Request logging

A search running under an initiating agent appends the log-only `web/deepseek-search-llm-request` session event immediately before dispatch. It carries the resolved endpoint, API version, and the exact secret-free JSON body sent to DeepSeek; headers and credentials are excluded. Credential failures and cancellations before dispatch create no event, while later HTTP or response failures leave the attempted request durable.

### Failures and recovery

Failures throw `WebError` with a machine-routable code: a missing credential is `WEB_PROVIDER_CREDENTIAL_MISSING`, caller cancellation is `WEB_ABORTED`, and provider or transport failures — including a response with no `web_search_tool_result` block — are `WEB_PROVIDER_ERROR`. HTTP redirects are rejected before the `Location` target is contacted. Every failure after dispatch names the resolved search endpoint and explains that search endpoint configuration is separate from chat. If the endpoint is unintended, the message tells the conversation model to guide the user to the Messages API base URL field under Plugins > Built-in plugin settings > Web search and save the change. When that page is unavailable, it names `web-search-deepseek.baseURL` as the deployment configuration alternative. The model must not choose or change the endpoint. The model-facing `web_search` tool surfaces this text under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on two commitments:

- **Structured blocks only.** DeepSeek runs the search server-side and returns structured `web_search_tool_result` blocks; the provider parses those blocks and never scrapes URLs out of model prose. In strict mode, a response with no such block throws `WEB_PROVIDER_ERROR` instead of degrading.
- **Conversation credentials, resolved per search.** The provider adds no secret: a search from a Session on the account route uses that account's token, and every other search reuses the `DEEPSEEK_API_KEY` reference. The auxiliary request endpoint stays independent through `$DEEPSEEK_SEARCH_BASE_URL`. A mounted credentials service is authoritative; without one the provider falls back to the launching process environment. Resolving per call means a key stored or rotated in the Web Models page, or an account sign-in, reaches the next search without a restart.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema, per-search option capture, and search readiness |
| [`src/provider.ts`](src/provider.ts) | The `DeepSeekSearchProvider`: Messages request dispatch, block parsing, citation joining, credential resolution |
| [`src/types.ts`](src/types.ts) | Anthropic wire types for the search response |

### Request flow

Each search captures the current Config values into provider options — endpoint, model, key reference, limits — then asks `ctx.deepseekAccount` for a token when the initiating Session uses the account route, otherwise resolves the credential reference through `ctx.credentials` (or the environment), appends the log-only session event, and dispatches the Messages request with the native `web_search` server tool. The response's `web_search_tool_result` blocks become `sources[]`; `cited_text` entries from text blocks are joined to their URLs as snippets; results are deduplicated by URL; and the service enforces the requested source bound on the way back.

Readiness captures the same options but reads no API key value: on the account route it first asks `ctx.deepseekAccount` for a token, then checks the literal key or asks `ctx.credentials.describe()` (or the environment) whether the key reference is configured.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-deepseek) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.
- [Search readiness decision](../../../.agents/notes/implemented/architecture/2026-09-27-web-search-offered-by-provider-readiness.md) — why this provider reports readiness while `dsh-tool-web` withholds `web_search`.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary DeepSeek search request

#### What the model sees

A separate DeepSeek model receives exactly `Perform a web search for the query: <query>` as its user text and one native `web_search` server-tool definition, with thinking disabled. This request is not part of the conversation model's context.

#### Token effect

Separate provider input and output tokens are incurred for each search; disabled thinking adds no reasoning tokens, `maxTokens` caps generated output, and `maxUses` caps native search uses.

#### KV Cache effect

Independent of the conversation request cache. The auxiliary instruction and native tool definition can form a stable prefix, but each changed query or model route prevents reuse from its first difference.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees deduplicated URLs, titles, dates, and citation snippets from structured search blocks; provider prose is not trusted as an answer. This provider's exact failures include the actionable missing-credential message, which also names DeepSeek Account sign-in, `DeepSeek search credential resolution failed: <error>`, and `DeepSeek search aborted`. An HTTP 401 to an account-authenticated search appends an instruction to guide the user to sign in to DeepSeek again. Other request, HTTP, native-search, and response-body failures append the resolved endpoint and the conditional configuration instruction described above. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Result tokens scale with returned sources and snippets, then the service enforces the requested source bound.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Conversation tool list, indirectly

#### What the model sees

While this provider is selected, a conversation request for which it is not ready carries neither the `web_search` schema nor its prompt guidance; [`dsh-tool-web`](../tool-web/README.md#search-readiness) owns that effect.

#### Token effect

Withholding removes the `web_search` schema and its prompt guidance from the request.

#### KV Cache effect

A returning or removed `web_search` changes the declared tools as [`dsh-tool-web`](../tool-web/README.md#search-readiness) describes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is expensive or incomplete. They are current package constraints.

- **One search costs a full Messages model turn** — latency plus generated tokens, with up to `maxUses` server-side searches; [dsh-web-deepseek-api](../web-deepseek-api/README.md) uses the dedicated Search API instead.
- **Provider selection cannot see a missing key** — the synchronous availability check can establish that a resolver exists but cannot query an asynchronous credential store, so `ctx.web` still selects a keyless provider and a direct search fails with `WEB_PROVIDER_CREDENTIAL_MISSING`; the asynchronous `ready()` affects only which model requests are offered `web_search`.
- **Readiness checks presence, not validity** — a wrong key, or an endpoint without the native `web_search_20250305` server tool, counts as ready, so `web_search` stays offered and each call fails with a structured error.
- **Search does not follow the chat endpoint** — when the official route chats through a gateway, search still sends its key to the configured search endpoint, the official one by default, and fails unless that endpoint accepts the key.
- **Over-returned sources still cost tokens** — with no result-count knob on the wire, `maxResults` is enforced only post-hoc by service truncation.
- **Sources usually carry no `snippet`** — a source gains one only when a text-block citation (`cited_text`) matches its URL, and DeepSeek's Anthropic-compatible endpoint returns text blocks without `citations`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Dedicated retrieval endpoint

DeepSeek's Search and Fetch APIs, which avoid the full model turn, live in [dsh-web-deepseek-api](../web-deepseek-api/README.md) and are selected by the Web search settings switch; this provider stays the default until the Search API launch is announced.

</details>
