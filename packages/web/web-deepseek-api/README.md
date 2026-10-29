---
description: "DeepSeek Search and Fetch API providers, their shared authentication and transport, endpoint configuration, and normalized results."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-deepseek-api

English | [中文](README.zh.md)

## Summary

Search and fetch the web through the DeepSeek Search and Fetch APIs: one direct request per operation, without an auxiliary model request. The plugin registers `deepseek-search-api` and `deepseek-fetch-api`, which share one credential and one API base, and authenticates with an API key or the configured account integration. Search returns titles, URLs, available snippets and summaries, and available publication dates; Fetch returns page Markdown. Messages search stays in [dsh-web-search-deepseek](../web-search-deepseek/README.md); the model-facing tools live in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin alongside `dsh-web` and select its providers. Shipped profiles mount it while selecting Messages search and local HTTP fetch. Turning on **Use the new Web Search API** in **Plugins > Built-in plugin settings > Web search** and saving selects both providers of this package; turning it off restores the shipped selection. A saved selection applies to the next operation.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal API key; prefer a credential reference |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved for each operation |
| `baseURL` | `https://api.deepseek.com/v1/tools` | Search and Fetch API base including its deployment path prefix; append `/search` or `/fetch` |
| `count` | `10` | Search API results per search, an integer from 1 to 50; a smaller `maxResults` on the request wins |
| `sendOriginalQuestion` | `true` | Send the triggering human prompt, cut to 128 characters, as the Search API's `ori_question` |

Fill `baseURL` with the complete API base, including its path prefix and excluding the operation name. The default reaches `https://api.deepseek.com/v1/tools/search` and `https://api.deepseek.com/v1/tools/fetch`; a deployment with another prefix, such as `/api/v1/tools`, needs its complete base.

Run the real API tests with `DEEPSEEK_API_KEY` and `DEEPSEEK_SEARCH_API_TEST_BASE_URL`; both are required, and the latter includes the API path prefix.

<a id="authentication"></a>
### Authentication

A Session using the `deepseek-account` route asks the account service for a token authorized for the resolved endpoint and sends it as `x-dsh-auth-token`; the public Search and Fetch routes accepted it on 2026-10-16. Otherwise a non-empty literal `apiKey` wins over `apiKeyEnv`; the reference resolves through `ctx.credentials`, or the launch environment when that service is absent. API keys use `Authorization: Bearer`. Credential resolution and endpoint selection share one settings snapshot.

Each provider's `ready()` answers whether an operation for a model request has a credential, on any model route: the request's route is `deepseek-account` and `ctx.deepseekAccount` resolves a token for the API base, or a literal `apiKey` is set or `ctx.credentials.describe` reports the `apiKeyEnv` reference configured (without that service, the launch environment must carry it). A failed account-token or credential-store read answers false. While these providers are selected, [`dsh-tool-web`](../tool-web/README.md#search-readiness) withholds `web_search` and `web_fetch` with their prompt guidance from each request for which they answer false. Only presence is checked: a wrong key counts as ready and fails each call.

### Results and failures

The Search API receives `query`, `count` (the configured count, or the request's smaller `maxResults`), `need_content: false`, and, unless `sendOriginalQuestion` is off, `ori_question`: the text of the initiating Session's latest human prompt with whitespace collapsed and cut to 128 characters. A search outside a Session or without such a prompt omits it. The provider maps `results[].snippet` as the display excerpt and `results[].summary` as the model-facing excerpt, and maps nullable `date` to optional `publishedAt`; `dsh-tool-web` caps each summary. An empty results array is successful. Fetch sends `url` and returns the original Markdown as a text body with HTTP status 200, because the API answers with an error status when the target yields no usable content. Its URL is the requested URL: the API reports no final redirected URL.

A blank or unparseable `baseURL` makes both providers unavailable, and a `count` outside 1 to 50 makes Search unavailable. Missing credentials fail with `WEB_PROVIDER_CREDENTIAL_MISSING`; cancellation uses `WEB_ABORTED`; transport, HTTP, and malformed response failures use `WEB_PROVIDER_ERROR`. Redirects are rejected before contacting their target. Non-success Fetch API statuses are retrieval failures, not target-page statuses. Account-authenticated HTTP 401 responses provide sign-in guidance; other dispatch failures identify the endpoint and the `baseURL` settings field. No automatic retry or provider fallback occurs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) reads its settings once per operation and registers both providers. The [Search provider](src/search.ts) validates response JSON before returning service results; the [Fetch provider](src/fetch.ts) validates the Markdown body. The [transport](src/transport.ts) owns credential resolution, cancellation, redirect rejection, and failure guidance; a recording hook runs before dispatch and prevents it by throwing. Search and Fetch API calls emit no auxiliary request event. Tool calls and results retain their normal Session logging.

See the [web subsystem](../../../docs/subsystems/web.md) for service types and [tool-web](../tool-web/README.md) for bounded model output.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Conversation tool results

#### What the model sees

The `web_search` and `web_fetch` tools render sources or Markdown with an external-content notice. Fetch results carry the requested URL and HTTP 200. Errors retain actionable credential or endpoint guidance. Search sends the query, with the triggering question, directly to the Search API.

#### Token effect

No auxiliary model tokens are consumed. Conversation result tokens scale with returned summaries, snippets, or Markdown and are bounded by the consumer. API retrieval billing is independent of model tokens.

#### KV Cache effect

Tool results append after the existing conversation prefix. Provider registration adds no model context.

### Conversation tool list, indirectly

#### What the model sees

While these providers are selected, a conversation request for which one is not ready carries neither its tool's schema, `web_search` or `web_fetch`, nor that tool's prompt guidance; [`dsh-tool-web`](../tool-web/README.md#search-readiness) owns that effect.

#### Token effect

Withholding removes the tool's schema and its prompt guidance from the request.

#### KV Cache effect

A returning or removed web tool changes the declared tools as [`dsh-tool-web`](../tool-web/README.md#search-readiness) describes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shared search request does not expose `localization`; the provider does not request full search content or consume `site_name`, `site_icon`, `rerank_score`, or `authority`. Returned summaries measured 1,000–2,300 characters on 2026-10-16, above the consumer's default cap.
- In 2026-10-16 probes, different `ori_question` values left result order, scores, and summaries unchanged; the provider still sends it because the guide documents it as an intent signal.
- API query and URL constraints are enforced by the remote service. An unresolvable Fetch target returned HTTP 500 rather than the documented 404 on 2026-10-16, and its failure carries the same endpoint guidance as an endpoint failure. Fetch exposes neither the target status nor the final redirect URL, so results report HTTP 200 and the requested URL; the provider discards the API's page title.
- `available()` cannot query asynchronous credential stores; `ready()` does, so model steps withhold the tools when the store lacks the key. A direct `ctx.web.search()` or `ctx.web.fetch()` call can still fail with a missing-credential error.
- When the official route chats through a gateway, operations still send the key to the configured API base and fail unless it accepts the key.

<a id="dev-note"></a>
### Dev Note

None.
