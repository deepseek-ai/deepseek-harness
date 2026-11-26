---
description: "DeepSeek Search and Fetch API providers, their shared authentication and transport, endpoint configuration, and normalized results."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-deepseek-api

English | [中文](README.zh.md)

## Summary

Search and fetch the web through the DeepSeek Search and Fetch APIs: one direct request per operation, without an auxiliary model request. The plugin registers `deepseek-search-api` and `deepseek-fetch-api`; each capability's billing chooses its DeepSeek credential: by default the conversation's account or API key on a DeepSeek model provider, otherwise the API key, then the signed-in account; it can also be fixed to either. YAML can give either capability its own base URL and key instead. Search returns titles, URLs, snippets, summaries, and dates; Fetch returns page Markdown. The model-facing tools live in `dsh-tool-web`; [legacy Messages search](../web-search-deepseek/README.md) remains a separate provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin alongside `dsh-web` and [`dsh-deepseek-auth`](../../account/deepseek-auth/README.md), which releases its credentials, and select its providers. Shipped profiles mount it, configure no search provider, and select local HTTP fetch for fetch; an unconfigured search runs its Search API (`deepseek-search-api`) except for a model request on a DeepSeek model route, which runs [legacy Messages search](../web/README.md#provider-selection). In **Plugins > Built-in plugin settings > Web search and fetch**, choosing **DeepSeek Search API** in the **Search** menu selects `deepseek-search-api` and choosing **DeepSeek Fetch API** in the **Fetch** menu selects `deepseek-fetch-api`; each menu is saved independently, and choosing another entry restores another provider. While a menu selects one of these providers, its **Billing** menu below writes `searchBilling` or `fetchBilling`: **Automatic**, **Signed-in DeepSeek account**, or **DeepSeek API key**. A saved selection applies to the next operation.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- name: '@deepseek-ai/dsh-deepseek-auth'
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
| `searchBilling` | `auto` | Credential Search sends without own settings: `auto`, `account`, or `api-key` ([authentication](#authentication)) |
| `fetchBilling` | `auto` | Credential Fetch sends without own settings, with the same values |
| `searchBaseURL` | omitted | Search API base including its path prefix; `/search` is appended. Set alone, `searchApiKeyEnv` defaults to `DEEPSEEK_API_KEY` ([authentication](#authentication)) |
| `searchApiKeyEnv` | omitted | Search credential reference. Set alone, `searchBaseURL` defaults to `https://api.deepseek.com/v1/tools` |
| `fetchBaseURL` | omitted | Fetch API base including its path prefix; `/fetch` is appended, with the same defaults |
| `fetchApiKeyEnv` | omitted | Fetch credential reference, with the same defaults |

A capability with neither field follows its billing and reaches `/v1/tools/search` and `/v1/tools/fetch` under the origin of the selected DeepSeek model route's resolved Messages base URL, so the official `https://api.deepseek.com/anthropic`, or a `DEEPSEEK_BASE_URL` override, becomes `https://api.deepseek.com/v1/tools`, or the override's origin with `/v1/tools`. The `dsh` launcher accepts `DEEPSEEK_BASE_URL` from the launching environment or `$DSH_HOME/.env`, never from a project `.env` ([app-boot](../../boot/app-boot/README.md)). Fill an own base URL with the complete API base, including its path prefix and excluding the operation name; a deployment with another prefix, such as `/api/v1/tools`, needs its complete base. An empty field counts as unset. The own fields are YAML-only and take precedence over billing; the settings page shows only the billing menu for these providers. Stored `baseURL`, `apiKeyEnv`, and `apiKey` fields of earlier settings load without error and have no effect.

Run the real API tests with `DEEPSEEK_API_KEY` and `DEEPSEEK_SEARCH_API_TEST_BASE_URL`; both are required, and the latter includes the API path prefix.

<a id="authentication"></a>
### Authentication

Search and Fetch each resolve their endpoint and credential from one settings snapshot per operation, so a saved setting, a model-provider change, a sign-in, or a stored key applies to the next operation. The conversation's route is the `provider` of the initiating Session's latest request context; `ready()` uses the route its caller names, which `dsh-tool-web` takes from the Agent's current model selection.

- **Own settings.** A capability with a non-empty `*BaseURL` or `*ApiKeyEnv` sends only the key under its `*ApiKeyEnv` (`DEEPSEEK_API_KEY` when unset) as `Authorization: Bearer` to its `*BaseURL` (`https://api.deepseek.com/v1/tools` when unset) on every route, and never the account token. Without the key, the operation fails with a diagnostic that names the reference and the `*ApiKeyEnv` field.
- **Account credential.** The operation sends the credential `ctx.deepseekAccount` releases for the dispatch endpoint as `x-dsh-auth-token`; the public Search and Fetch routes accepted it on 2026-10-16. With the `deepseek-account` model route mounted, the endpoint is under the origin of that route's base URL; without that route, it is under the origin `DEEPSEEK_BASE_URL` names, `https://api.deepseek.com` by default. No sign-in or no account service means no credential. A failed credential read fails the operation without trying another credential. A mounted route whose settings do not resolve, or a `DEEPSEEK_BASE_URL` that is not an HTTP(S) URL without credentials, fails the operation before the credential is read when the operation reaches this source.
- **API key.** With the `deepseek-official` model route mounted, the operation sends that route's key, read under the route's `apiKeyEnv` (`DEEPSEEK_API_KEY` by default), as `Authorization: Bearer` to the origin of the route's base URL. Without that route, it sends `DEEPSEEK_API_KEY` to `https://api.deepseek.com/v1/tools`. A mounted route whose settings do not resolve fails each operation that needs the key, before the key is read; the operation never substitutes the official endpoint or `DEEPSEEK_API_KEY`.
- **`auto` billing** follows the conversation. On the mounted `deepseek-account` route it sends the account credential, and without one the API key. On the mounted `deepseek-official` route it sends only the API key. On any other route, on either of those route ids while its plugin is not mounted, or outside a Session it sends the API key, and without a key the account credential; without a key, a mounted account route whose settings do not resolve fails the operation.
- **`account` billing** sends only the account credential on every route, and **`api-key` billing** only the API key; neither falls back to the other credential.

Without a credential, the operation fails with a diagnostic for its billing that names the missing sign-in or the Models page and the key reference, and the `*Billing` field on the Web search and fetch settings page.

`ctx.deepseekAuth` reads every key, the API-key route's, `DEEPSEEK_API_KEY` without that route, and the own `*ApiKeyEnv`, through the credential reference helpers of [`dsh-credentials`](../../credentials/credentials/README.md): `ctx.credentials` is authoritative, with launch-environment lookup only when that service is absent. Every key receives the same whitespace normalization and format validation as model requests; malformed keys fail before dispatch.

Each provider's `ready()` answers whether its next operation for that route has a credential, in the order its billing resolves them: an account credential the account service releases for the endpoint, or a key that `ctx.credentials.describe` reports configured (without that service, the launch environment must carry it). A failed credential or credential-store read, or a needed route whose settings do not resolve, answers false. While these providers are selected, [`dsh-tool-web`](../tool-web/README.md#search-readiness) withholds `web_search` and `web_fetch` with their prompt guidance from each request for which they answer false. Only presence is checked: a wrong key counts as ready and fails each call.

### Results and failures

The Search API receives `query`, `count` (the configured count, or the request's smaller `maxResults`), `need_content: false`, and, unless `sendOriginalQuestion` is off, `ori_question`: the text of the initiating Session's latest human prompt with whitespace collapsed and cut to 128 characters. A search outside a Session or without such a prompt omits it. The provider maps `results[].snippet` as the display excerpt and `results[].summary` as the model-facing excerpt, and maps nullable `date` to optional `publishedAt`; `dsh-tool-web` caps each summary. An empty results array is successful. Fetch sends `url` and returns the original Markdown as a text body with HTTP status 200, because the API answers with an error status when the target yields no usable content. Its URL is the requested URL: the API reports no final redirected URL.

An own base URL that does not parse or that embeds credentials makes that capability's provider unavailable; and a `count` outside 1 to 50 makes Search unavailable. A missing credential fails with `WEB_PROVIDER_CREDENTIAL_MISSING`; a needed model route whose settings do not resolve fails with `WEB_PROVIDER_MISCONFIGURED`, naming the resolver failure, the Models page, and the capability's `*BaseURL` and `*ApiKeyEnv`; cancellation uses `WEB_ABORTED`; transport, HTTP, and malformed response failures use `WEB_PROVIDER_ERROR`. A request ends when the credential it carries is withdrawn, as an account sign-out does through the authorization's `revoked` signal: it fails with `WEB_PROVIDER_ERROR` and guidance to sign in again, or for another credential kind to check that credential on the Models page, unless the caller cancelled as well, which stays `WEB_ABORTED`. Redirects are rejected before contacting their target. Non-success Fetch API statuses are retrieval failures, not target-page statuses. Account-authenticated HTTP 401 responses invalidate only the token sent by that request and provide sign-in guidance; a newer sign-in is preserved, and credential-removal failure does not replace the HTTP error. API-key failures and HTTP 403 never invalidate an account token; other dispatch failures identify the endpoint and say where it came from: for a route endpoint they guide the user to that provider's base URL on the Models page or to the capability's `*BaseURL` and `*ApiKeyEnv`, and for own settings to correcting or removing those fields. No automatic retry or provider fallback occurs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) reads its settings once per operation, registers both providers, and asks [`ctx.deepseekAuth`](../../account/deepseek-auth/README.md) with one capability's settings snapshot and the conversation's route for the operation's ordered credentials, each bound to the endpoint it is sent to. The plugin words the failures of a missing credential and of settings that do not resolve. The [Search provider](src/search.ts) validates response JSON before returning service results; the [Fetch provider](src/fetch.ts) validates the Markdown body. The [transport](src/transport.ts) reads those credentials in order, sends one request with the headers of the first present one, and owns cancellation, redirect rejection, and failure guidance; a recording hook runs before dispatch and prevents it by throwing. Search and Fetch API calls emit no auxiliary request event. The [Messages search provider](../web-search-deepseek/README.md) owns its `web/deepseek-search-llm-request` Session event declaration and recording. Tool calls and results retain their normal Session logging.

See the [web subsystem](../../../docs/subsystems/web.md) for service types and [tool-web](../tool-web/README.md) for bounded model output.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Conversation tool results

#### What the model sees

The `web_search` and `web_fetch` tools render sources or Markdown with an external-content notice. Fetch results carry the requested URL and HTTP 200. Errors retain actionable credential or endpoint guidance; a request the account's sign-out ended reports `The DeepSeek account signed out before this web request finished. Guide the user to sign in to DeepSeek again; the endpoint does not need changing.` Search sends the query, with the triggering question, directly to the Search API.

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
- Route endpoints, credentials, and the `auto` order follow what the `llm-deepseek-api-key` and `llm-deepseek-account` plugins connect to `ctx.deepseekAuth`. Another adapter registered as `deepseek-official` or `deepseek-account`, such as a test replay adapter, counts as no DeepSeek route: under `auto` billing its conversations send `DEEPSEEK_API_KEY` to the official base and, without a key, the account credential, and `account` billing asks the account service as it does without the account route.

<a id="dev-note"></a>
### Dev Note

None.
