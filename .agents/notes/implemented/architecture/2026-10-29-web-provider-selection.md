# Agent Note: Web provider selection - independent menus over registered providers

Status: implemented

English | [中文](2026-10-29-web-provider-selection.zh.md)

## Problem

The web service selects search and fetch providers through two independent fields, `web.searchProvider` and `web.fetchProvider`. A settings control that writes both at once ties fetch billing and target access policy to the search choice, and a control that offers only the DeepSeek choices it knows cannot select a provider that another plugin registers. A picker over registered providers needs the Host to report them, and the [web capability seam](2026-06-24-web-capability-seam.md) has no availability observation for it to reuse. Messages search starts an auxiliary model request for each query, whereas the [Search API](../feature/2026-10-15-deepseek-search-fetch-api.md) returns structured sources directly. The Search and Fetch APIs also need a DeepSeek credential, and a credential setting of their own makes every user reconcile it with the model provider they chat with.

## Decision

Users choose search and fetch providers independently from the Host's registered provider lists. The shipped composition selects the Search API for search and local HTTP fetch for fetch, and the DeepSeek Search and Fetch APIs follow the conversation's DeepSeek credential.

### Registered providers are observable; availability is not

`WebSearchProvider` and `WebFetchProvider` carry an optional `title`, the provider's display name, and an optional localized `description` of what the provider suits and what it costs or cannot do. `ctx.web.listProviders()` returns `{ search, fetch }`, each a registration-ordered list of `{ id, title?, description? }` entries, and the `web` Remote namespace exposes it as `web/listProviders`. Every registration and disposal emits the payload-free `web/providers-changed` event after the registry changes; the web service contains listener failures, so an observer cannot veto a registry change. [dsh-api-remotes](../../../../packages/api/remotes/README.md) mounts the namespace and forwards the event, and Clients re-read the list after each notification and reconnect.

The lists include providers whose `available()` answers false. A picker shows what can be pinned, including a provider whose credential the user has not configured yet, whereas availability depends on per-request facts such as the Session's model route and credential state. Availability therefore stays an execution result: `search()` and `fetch()` resolve the configured provider at call time and throw the structured `WebError`, as the seam note records. The tool layer still never enumerates providers.

### Independent selection

The Web search and fetch page writes `web.searchProvider` from its Search menu and `web.fetchProvider` from its Fetch menu. Each menu lists every registered provider for its capability by `title` (or `id` when `title` is absent), so plugin providers appear without page changes, and a selected id that the Host does not register stays visible as such. Official providers register no `title`; the page names them from its own locale dictionary and lists them first in a fixed order: the Search API (`deepseek-search-api`) followed by Messages search (`deepseek-official`) for search, and local HTTP fetch (`http`) followed by the Fetch API (`deepseek-fetch-api`) for fetch. Other providers follow in Host registration order. Selecting the deployment's composed provider clears the stored override instead of storing a duplicate value. The [settings page README](../../../../packages/client/ui-settings-web-search/README.md) owns the page's controls.

Every registered provider is listed; a provider has no flag that keeps it out of the menus. This note supersedes the [Search and Fetch API decision](../feature/2026-10-15-deepseek-search-fetch-api.md)'s rejection of listing every registered provider in a settings dropdown. Independent menus must offer providers that other plugins register, and the display metadata that listing needs is only the optional `title` and `description`. The description lives on the registration rather than in the page's dictionaries so that official and plugin providers explain themselves through one field, and a new provider needs no page change to describe its trade-offs. The rejected generic editor still stands: the page edits only the DeepSeek providers' settings, and other providers keep their own settings pages.

The Search and Fetch APIs read one `web-deepseek-api` namespace, and each resolves its own credential and endpoint, as the next section records. Messages search reads `web-search-deepseek` for its independent endpoint and key reference.

### Credential resolution

Each of Search and Fetch has a billing setting, `web-deepseek-api.searchBilling` or `fetchBilling`, which the settings page edits as a **Billing** menu under the selected API. The default, `auto`, follows the DeepSeek credential of the conversation; `account` sends only the signed-in account's token and `api-key` only the API key, without falling back to the other. The conversation's route is the `provider` of the initiating Session's latest request context, which account sign-out also reads; `ready()` uses the route of the model request being prepared, so readiness and execution resolve the same plan.

The account token is the one `ctx.deepseekAccount` releases for the dispatch endpoint under the origin of the active `@deepseek-ai/dsh-llm-deepseek-account` Loader entry at the entry root that the model provider directory lists, with `/v1/tools`; without that entry, the origin of that route's default base URL is used. An HTTP 401 invalidates that token. With `auto` billing on the `deepseek-account` route, the operation sends the account token when that entry exists and a token is released. Every other `auto` operation, including one in an account conversation without a sign-in or a token, sends the key under the `apiKeyEnv` of the active `@deepseek-ai/dsh-llm-deepseek-api-key` entry for `deepseek-official`, resolved with that package's own resolver (including `DEEPSEEK_BASE_URL`), to the origin of that route's base URL with `/v1/tools`; without that entry, `DEEPSEEK_API_KEY` goes to `https://api.deepseek.com/v1/tools`. With `auto` billing on a route other than the two DeepSeek routes, or outside a Session, an operation without a configured key sends the account token instead, so a signed-in user without a key keeps web tools in conversations on other model providers; on the `deepseek-official` route it never sends the token, because that conversation bills the API key. Sending the API key in a signed-out account conversation keeps web tools available there. A user with only `DEEPSEEK_API_KEY`, including every headless, SDK, and ACP run, therefore searches and fetches by default, and a gateway or internal deployment set through the model provider's base URL serves web access at the same origin. A missing credential makes the capability not ready, and an operation fails with `WEB_PROVIDER_CREDENTIAL_MISSING` and guidance for its billing that names the account sign-in, the Models page and the reference, and the billing field. A mounted route entry whose settings its resolver rejects is not treated as absent: an operation that needs that route is not ready and fails with `WEB_PROVIDER_MISCONFIGURED` before reading the credential that depends on that route, without trying later sources or sending the request, so a broken gateway setting never redirects requests to the official endpoint.

A capability whose YAML sets a non-empty `searchBaseURL` or `searchApiKeyEnv` (`fetchBaseURL` or `fetchApiKeyEnv` for Fetch) instead, whatever its billing, always sends the key under its `*ApiKeyEnv` (`DEEPSEEK_API_KEY` when unset) to its `*BaseURL` (the official base when unset) and never the account token, so an intranet or third-party endpoint receives only the key chosen for it. Each capability has its own fields because a deployment can serve search and fetch from different gateways. These fields are YAML-only, and an empty value counts as unset. Stored values of fields outside the schema, including `baseURL`, `apiKeyEnv`, and `apiKey`, load without schema errors and have no effect.

The [credential helpers](../../../../packages/llm/llm-deepseek/src/credential.ts) of `@deepseek-ai/dsh-llm-deepseek` read and validate API keys, check key presence, and release account tokens for the DeepSeek model routes, Messages search, and the Search and Fetch APIs, so every DeepSeek request reads the credential store the same way; the account model route, Messages search, and the Search and Fetch APIs also invalidate the token that an HTTP 401 rejects. Shipped profiles need no per-profile credential override, because the API-key path works wherever `DEEPSEEK_API_KEY` or the DeepSeek API-key route has a key.

### Defaults and stored selections

The [base composition](../../../../packages/bundle/base/cordis.patch.yml) sets `searchProvider: deepseek-search-api` and `fetchProvider: http`. Search defaults to the Search API because it returns sources without Harness starting an auxiliary model request. Fetch defaults to local HTTP fetch because it has no per-request API charge, applies Harness's own URL validation and resource limits, and reaches intranet and local addresses. The Fetch API remains one menu choice away.

A stored selection, whether in the settings document or in a deployment's own composition, wins over the shipped default, and an upgrade does not rewrite it. A selection is never replaced at execution: when the selected provider is missing, unavailable, or fails, the operation fails with its structured error and does not fall back to another search or fetch provider. A fallback would send the query and credential to an endpoint the user did not choose and change billing without notice.

### Legacy Messages search

The DeepSeek Messages search provider remains available as **DeepSeek (legacy)**. A stored `web.searchProvider: deepseek-official` (or `DSH_WEB_SEARCH_PROVIDER=deepseek-official`) selects it, so users whose gateways serve Messages search but not `/v1/tools` can retain their working provider.

The Messages provider owns and writes `web/deepseek-search-llm-request`. The declaration and payload retain compatibility with released Sessions; the Search and Fetch API package neither declares nor writes this auxiliary event.

## Alternatives considered

**Keep one switch for both APIs.** It lets Fetch API adoption need no configuration edit, but it ties fetch billing and target access policy to the search choice, and it cannot express a provider that another plugin registers.

**Filter the lists by availability, or add availability to each entry.** A filtered list hides a provider while its credential is missing, right when the user needs to choose and configure it. Availability also depends on the request's model route and credential state, so a listed boolean could disagree with execution. The archived [observation-surface decision](../../archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.md) allows only the smallest signal a consumer reads; the menus read registration only.

**Keep a fixed provider catalog in the Client.** The Client would show ids the Host does not register as normal choices and would never show a provider that a plugin registers at runtime.

**Carry the provider list in the change event.** A payload-free event leaves one read path for initial load, notifications, and reconnects, so the Client never has to order an event payload against a concurrent read.

**Keep display names in the Client or in a separate Host registry.** The registering plugin knows its provider's name; a separate map would let a provider and its label register or dispose independently.

**Fall back to another provider when the selected one fails.** A fallback hides gateway and credential misconfiguration, sends the query to a second service, and changes what the request costs without the user choosing it.

**Remove Messages search and let a stored `deepseek-official` select the Search API.** Gateways can support Messages search without Search API routes. Retaining the legacy provider preserves that choice instead of changing its protocol and billing.

**Default fetch to the Fetch API as well.** It adds a per-request charge to every fetch and delegates page retrieval and target access policy to the service, which fetches from its own side rather than from the user's machine.

**Choose a credential source per capability on the settings page**, from a menu listing the configured DeepSeek model providers plus a custom key and base URL, without fallback between sources. The visible setting would state the whole rule, but the configuration surface is too large for users to understand: each capability adds a credential menu that the user must keep in step with the model provider they chat with, and a signed-in user chatting on the account route gets no web tools until they change it. The default `auto` billing follows the conversation's credential without configuration, the billing menu offers only the two DeepSeek credentials, and the YAML-only own fields cover endpoints that differ from the model provider.

**Share one custom key and base URL between Search and Fetch.** It cannot express a deployment that serves the two APIs from different gateways.

**Fail an account conversation without a sign-in instead of sending the API key.** It would keep the account route from ever billing the API key, but signed-out account conversations would lose web tools even when a DeepSeek API key is configured.

**Send the account token whenever the user is signed in, whatever the conversation's route.** It would bill web access to the account during conversations on the API-key route or on another provider, which the user did not choose for them.

## Consequences

Users without a stored search selection search through the Search API: their queries go to the Search endpoint the conversation's DeepSeek credential selects, cost a Search API request each, and send up to 128 characters of the latest human prompt as `ori_question` unless `sendOriginalQuestion` is off. Deployments whose gateway has no `/v1/tools` routes get search failures until they select Messages search or set `searchBaseURL` to a base that serves them. A stored `deepseek-official` selection uses Messages search. Users without a stored fetch selection fetch through local HTTP fetch. A signed-in user without an API key has DeepSeek web search with `auto` billing in every conversation except those on the DeepSeek API-key route; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/web-search-credential-modes/guide.md) lists each affected setup.

A plugin provider, including one written in creator mode, appears in the matching menu as soon as it registers, under its `title`. The menus can offer a provider that cannot run for the current request; the failure appears when a search or fetch runs. Each registry change costs one forwarded event and one list read in each Client that observes it.

## Verification

[web.spec.ts](../../../../packages/web/web/tests/web.spec.ts) covers list contents and order, titles, events after registration and disposal, no event for a rejected duplicate, and contained listener failures. [deepseek.spec.ts](../../../../packages/web/web-search-deepseek/tests/deepseek.spec.ts) covers the independent Messages provider, and [credential-resolution.spec.ts](../../../../packages/web/web-deepseek-api/tests/credential-resolution.spec.ts) covers, for both capabilities, the account token on the account route and its invalidation after HTTP 401, the API-key fallback without a sign-in, the route key and endpoint in official, non-DeepSeek, and Session-less conversations, the account fallback without a key outside the DeepSeek routes, account-only and API-key-only billing on every route, own fields over billing, `DEEPSEEK_API_KEY` and the official base without that route, YAML-only own fields that never send the token, independent capabilities, readiness matching each operation, and ignored removed fields; [composition.spec.ts](../../../../packages/web/web-deepseek-api/tests/composition.spec.ts) boots the real model routes through the Loader. [remote-events.host.spec.ts](../../../../packages/api/remotes/tests/remote-events.host.spec.ts) covers event forwarding, and [base.spec.ts](../../../../packages/bundle/base/tests/base.spec.ts) pins the shipped defaults. The settings page's controller and card specs and the [plugin configuration browser scenario](../../../../apps/web/tests/plugin-config.e2e.ts) cover menu contents, independent Search and Fetch selection, the billing menus of the DeepSeek APIs, and the settings each provider keeps.
