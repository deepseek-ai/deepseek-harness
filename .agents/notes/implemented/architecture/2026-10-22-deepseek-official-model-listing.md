# Agent Note: The official DeepSeek route follows the official model listing until its catalog is customized

Status: implemented

English | [中文](2026-10-22-deepseek-official-model-listing.zh.md)

## Problem

The `deepseek-official` route offered whatever its `models` setting held, and that setting defaults to the catalog bundled with each build. A model the DeepSeek API added reached API-key users only through a release, while the account route already followed the service's `GET /models` listing at the same origin. Unlike the account route's catalog, the official route's catalog is user-editable: the Models page stores an edited catalog in `models`, and a gateway behind `baseURL` declares its models there.

## Decision

- [`llm-deepseek-api-key`](../../../../packages/llm/llm-deepseek-api-key/README.md) follows `GET https://api.deepseek.com/models`, authenticated with the API key in `x-api-key`, only while the Messages origin is `https://api.deepseek.com` and `models` equals the built-in catalog. Any other endpoint or catalog sends no listing request.
- Loading, refresh, fallback, merging, and the client-version gate are the [account route's](2026-09-24-deepseek-account-remote-model-catalog.md): a first access waits up to `modelsTimeoutMs`, a listing older than `modelsMaxAgeMs` refreshes in the background on the next access, a failure keeps the last good listing or the built-in catalog, and the cache lives in memory, keyed by endpoint and key fingerprint.
- A customized `models` list wins whole: it replaces the catalog and stops listing requests. A list is customized when it resolves differently from the built-in catalog, because the schema default materializes an absent `models` as the built-in list and the Models page shows that default as its inherited rows.
- Switching between a customized catalog and the listing invalidates the cache from a `loader/volatile-update` listener, so Restore defaults reloads the listing on the next access even when the cached listing is fresh.
- The listing request, its cache, catalog resolution, and the gate live in the shared [Messages transport](../../../../packages/llm/llm-deepseek/README.md) because two routes consume them; the transport's provider hooks remain `connect` and `admit`.

## Alternatives considered

**Follow the listing on every endpoint.** A gateway that publishes an OpenAI-style `/models` returns entries without `api_capabilities.anthropic_messages`, which the decoder hides, so the route would offer no models. Every such gateway would also receive an extra request carrying the key.

**Merge the customized catalog with the listing by model id.** Customized users would keep receiving new listed models, but a model the user deleted would return, and the Models page cannot hide one listed model.

**Mark an unset `models` by removing its schema default.** An absent value would select the listing without comparing catalogs, but the Models page would lose the inherited rows it shows and copies, with their hidden `systemPromptUpdate` and `toolUpdate` fields, into a customized catalog. Rows copied from the generic model-discovery API would drop those fields.

**Fetch once per process, or refresh on a timer.** A single fetch leaves a long-running Web or desktop host on its startup catalog, and one transient failure pins it to the built-in catalog. A timer sends requests while the route is idle. Access-triggered background refresh matches the account route.

**Reuse the cached listing after Restore defaults.** The cache could serve a listing loaded before the customization for up to `modelsMaxAgeMs`; the request is cheap, so restoring always reloads it. The reload starts on the next access rather than inside the listener, which keeps credential lookup and its failures on the request path; the Web page's settings refresh makes that access right after the save.

## Consequences

- API-key users on the official endpoint receive listed models without a release, and an older build hides or refuses a model that needs a newer client, as account users' builds do.
- A customized catalog receives no later listed models until Restore defaults, and a `models` list identical to the built-in catalog counts as uncustomized. The comparison uses the running version's built-in catalog, so a saved list equal to an earlier version's built-in catalog counts as customized once the built-in catalog changes.
- The Models page shows the built-in rows while the listing is followed, so a model only the listing offers appears only in model selectors, and editing the page's catalog drops it.
- The first catalog access on the official endpoint can wait up to `modelsTimeoutMs`, and a suite that boots the route there must answer the listing itself to stay off the network.
