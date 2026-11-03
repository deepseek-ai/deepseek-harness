---
description: "DeepSeek Search and Fetch API providers, their shared authentication and transport, endpoint configuration, and normalized results."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-deepseek-api

English | [中文](README.zh.md)

## Summary

Search and fetch the web through the DeepSeek Search and Fetch APIs: one direct request per operation, without an auxiliary model request. The plugin registers `deepseek-search-api` and `deepseek-fetch-api`; each capability follows the DeepSeek credential of the conversation: the DeepSeek account sign-in in a conversation on the DeepSeek account model provider, otherwise the DeepSeek API key. YAML can give either capability its own base URL and key instead. Search returns titles, URLs, and available snippets, summaries, and publication dates; Fetch returns page Markdown. The model-facing tools live in `dsh-tool-web`; [legacy Messages search](../web-search-deepseek/README.md) remains a separate provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin alongside `dsh-web` and select its providers. Shipped profiles mount it and select its Search API (`deepseek-search-api`) for search and local HTTP fetch for fetch. In **Plugins > Built-in plugin settings > Web search and fetch**, choosing **DeepSeek Search API** in the **Search** menu selects `deepseek-search-api` and choosing **DeepSeek Fetch API** in the **Fetch** menu selects `deepseek-fetch-api`; each menu is saved independently, and choosing another entry restores another provider. A saved selection applies to the next operation.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    searchBaseURL: https://search.example.test/api/v1/tools
    searchApiKeyEnv: DEEPSEEK_SEARCH_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `count` | `10` | Search API results per search, an integer from 1 to 50; a smaller `maxResults` on the request wins |
| `searchRequestsPerSecond` | `5` | Most Search requests this plugin instance sends in any one-second window, matching the service's account-wide 5 QPS limit; later searches wait, and the wait counts against the caller's timeout |
| `sendOriginalQuestion` | `true` | Send the triggering human prompt, cut to 128 characters, as the Search API's `ori_question` |
| `searchBaseURL` | omitted | Search API base including its path prefix; `/search` is appended. Set alone, `searchApiKeyEnv` defaults to `DEEPSEEK_API_KEY` ([authentication](#authentication)) |
| `searchApiKeyEnv` | omitted | Search credential reference. Set alone, `searchBaseURL` defaults to `https://api.deepseek.com/v1/tools` |
| `fetchBaseURL` | omitted | Fetch API base including its path prefix; `/fetch` is appended, with the same defaults |
| `fetchApiKeyEnv` | omitted | Fetch credential reference, with the same defaults |

A capability with neither field follows the conversation and reaches `/v1/tools/search` and `/v1/tools/fetch` under the origin of the selected DeepSeek model route's resolved Messages base URL, so the official `https://api.deepseek.com/anthropic`, or a `DEEPSEEK_BASE_URL` override, becomes `https://api.deepseek.com/v1/tools`, or the override's origin with `/v1/tools`. Fill an own base URL with the complete API base, including its path prefix and excluding the operation name; a deployment with another prefix, such as `/api/v1/tools`, needs its complete base. An empty field counts as unset. The own fields are YAML-only; the settings page selects providers and shows no credential controls for these providers. Stored `baseURL`, `apiKeyEnv`, and `apiKey` fields of earlier settings load without error and have no effect.

Run the real API tests with `DEEPSEEK_API_KEY` and `DEEPSEEK_SEARCH_API_TEST_BASE_URL`; both are required, and the latter includes the API path prefix.

<a id="authentication"></a>
### Authentication

Search and Fetch each resolve their endpoint and credential from one settings snapshot per operation, so a saved setting, a model-provider change, a sign-in, or a stored key applies to the next operation. The conversation's route is the `provider` of the initiating Session's latest request context; `ready()` uses the route of the model request being prepared.

- **Own settings.** A capability with a non-empty `*BaseURL` or `*ApiKeyEnv` sends only the key under its `*ApiKeyEnv` (`DEEPSEEK_API_KEY` when unset) as `Authorization: Bearer` to its `*BaseURL` (`https://api.deepseek.com/v1/tools` when unset) on every route, and never the account token. Without the key, the operation fails with a diagnostic that names the reference and the `*ApiKeyEnv` field.
- **Account conversation.** On the `deepseek-account` route, with an active, valid Loader entry of `@deepseek-ai/dsh-llm-deepseek-account` at the entry root that the model provider directory lists for `deepseek-account`, the operation sends only the token that `ctx.deepseekAccount` releases for the dispatch endpoint under that route's origin, as `x-dsh-auth-token`; the public Search and Fetch routes accepted it on 2026-10-16. Without a sign-in, the account service, or a non-empty token, or without that entry, it sends the API key below instead, to the API-key endpoint. A failed account-token read fails the operation without trying the key. An active entry whose settings the route's own resolver rejects fails the operation before any credential is read.
- **Any other conversation**, including one on `deepseek-official`, on another provider, or outside a Session, sends the key under the `apiKeyEnv` of the active `@deepseek-ai/dsh-llm-deepseek-api-key` entry the directory lists for `deepseek-official` (`DEEPSEEK_API_KEY` by default) as `Authorization: Bearer` to that route's origin, resolving its options as the route does. Without that entry, or with an inactive one, it sends `DEEPSEEK_API_KEY` to `https://api.deepseek.com/v1/tools`. An active entry whose settings the route's own resolver rejects fails each operation that would send the key, before the key is read; the operation never substitutes the official endpoint or `DEEPSEEK_API_KEY`. Without the key, the operation fails with a diagnostic that names the Models page, the reference, and the account sign-in.

References use the [shared DeepSeek credential helpers](../../llm/llm-deepseek/README.md#account-credentials): `ctx.credentials` is authoritative, with launch-environment lookup only when that service is absent. Route and own keys receive the same whitespace normalization and format validation as model requests; malformed keys fail before dispatch.

Each provider's `ready()` answers whether its next operation for that route has a credential, in the order the operation resolves it: on the account route, a non-empty account token, then a key that `ctx.credentials.describe` reports configured (without that service, the launch environment must carry it). A failed account-token or credential-store read, or a needed route entry whose settings do not resolve, answers false. While these providers are selected, [`dsh-tool-web`](../tool-web/README.md#search-readiness) withholds `web_search` and `web_fetch` with their prompt guidance from each request for which they answer false. Only presence is checked: a wrong key counts as ready and fails each call.

### Results and failures

The Search API receives `query`, `count` (the configured count, or the request's smaller `maxResults`), `need_content: false`, and, unless `sendOriginalQuestion` is off, `ori_question`: the text of the initiating Session's latest human prompt with whitespace collapsed and cut to 128 characters. A search outside a Session or without such a prompt omits it. The provider maps `results[].snippet` as the display excerpt and `results[].summary` as the model-facing excerpt, and maps nullable `date` to optional `publishedAt`; `dsh-tool-web` caps each summary. An empty results array is successful. Fetch sends `url` and returns the original Markdown as a text body with HTTP status 200, because the API answers with an error status when the target yields no usable content. Its URL is the requested URL: the API reports no final redirected URL.

An unparseable own base URL makes that capability's provider unavailable; and a `count` outside 1 to 50 makes Search unavailable. A missing credential fails with `WEB_PROVIDER_CREDENTIAL_MISSING`; a needed model route whose settings do not resolve fails with `WEB_PROVIDER_MISCONFIGURED`, naming the resolver failure, the Models page, and the capability's `*BaseURL` and `*ApiKeyEnv`; cancellation uses `WEB_ABORTED`; transport, HTTP, and malformed response failures use `WEB_PROVIDER_ERROR`. Redirects are rejected before contacting their target. Non-success Fetch API statuses are retrieval failures, not target-page statuses. Account-authenticated HTTP 401 responses invalidate only the token sent by that request and provide sign-in guidance; a newer sign-in is preserved, and credential-removal failure does not replace the HTTP error. API-key failures and HTTP 403 never invalidate an account token; other dispatch failures identify the endpoint and say where it came from: for a route endpoint they guide the user to that provider's base URL on the Models page or to the capability's `*BaseURL` and `*ApiKeyEnv`, and for own settings to correcting or removing those fields. No automatic retry or provider fallback occurs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) reads its settings once per operation, registers both providers, and turns one capability's settings snapshot, the conversation's route, and the active model route entries into its endpoint and credential. The [Search provider](src/search.ts) validates response JSON before returning service results; the [Fetch provider](src/fetch.ts) validates the Markdown body. The [transport](src/transport.ts) owns credential resolution, the choice between the account endpoint and the API-key endpoint, cancellation, redirect rejection, and failure guidance; a recording hook runs before dispatch and prevents it by throwing. Search and Fetch API calls emit no auxiliary request event. The [Messages search provider](../web-search-deepseek/README.md) owns its `web/deepseek-search-llm-request` Session event declaration and recording. Tool calls and results retain their normal Session logging.

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
- Search pacing limits send times within one plugin instance. Other processes and clients on the same account share the account-wide 5 QPS limit without coordination, and network jitter can still bunch arrivals; an HTTP 429 fails that search, and `dsh-tool-web` then fails the whole multi-query call. Fetch is not paced, so parallel `web_fetch` calls can exceed the Fetch limit.
- Route endpoints and keys follow only the Loader entries of `@deepseek-ai/dsh-llm-deepseek-api-key` and `@deepseek-ai/dsh-llm-deepseek-account` at the entry root; another package registering the same provider id, such as a test replay adapter, counts as no route, so its conversations use `DEEPSEEK_API_KEY` and the official base.

<a id="dev-note"></a>
### Dev Note

None.
