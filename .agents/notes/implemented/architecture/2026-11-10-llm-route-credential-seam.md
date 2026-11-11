# Agent Note: Route credentials - DeepSeek model routes publish the credential consumers reuse

Status: implemented

English | [中文](2026-11-10-llm-route-credential-seam.zh.md)

## Problem

Several packages shared one DeepSeek credential without an owner. `@deepseek-ai/dsh-llm-deepseek`, the protocol transport, exported helpers that read `ctx.credentials`, the launch environment, and `ctx.deepseekAccount`, so the transport depended on both credential services although it only sends the headers a route gives it. The two route plugins resolved their credentials through those helpers and threw their own missing-credential failures from inside `resolveAuth`. The Search and Fetch API providers re-derived each route's base URL and key reference from the Loader entry of the route package with that package's own config resolver, and Messages search hard-coded the account route id, so both web packages depended on `llm-deepseek`, on both route plugins, and on the Loader. The account service, which sits below every consumer, owned Agent cancellation after sign-out and lived in the `credentials/` group beside the credential store it only uses. A change to how one route authenticates touched the transport, both web providers, and their tests.

## Decision

`@deepseek-ai/dsh-llm` owns the Service Definition. `LlmAdapter.routeCredential(provider)` publishes a `RouteCredential`: the route's `kind` (merge-extensible, with `api-key` and `account` declared), its resolved `baseURL`, an optional credential `reference` for diagnostics, `configured(endpoint)` for presence checks that read no value, and `resolve(endpoint, signal)` returning a `RouteCredentialGrant` with the protocol `headers`, the bare `value` for destinations that render it differently, and an optional `reject()` for HTTP 401. `LlmRuntime.routeCredential(provider)` forwards to the owning adapter; an unregistered route answers `undefined`, and a route whose configuration does not resolve propagates the adapter's failure. The adapter reads one configuration generation per call, as it does per model request.

`@deepseek-ai/dsh-llm-deepseek` reads no credential. `DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` returns the grant or `undefined`; `missingCredential(connection, provider)` names the failure of a request without one, `MISSING_CREDENTIAL` by default; `credential` declares the published kind, reference, and presence check. The listing cache scopes by endpoint and a hash of the credential headers.

The route plugins own credentials. `llm-deepseek-api-key` reads its key through `resolveCredentialRef` and `credentialRefConfigured`, new in `@deepseek-ai/dsh-credentials`, which treat a mounted credentials service as authoritative and read the launch environment only without one; it publishes kind `api-key` with the `apiKeyEnv` reference. `llm-deepseek-account` reads `ctx.deepseekAccount.resolveRequestCredential(endpoint)`, maps HTTP 401 to `ACCOUNT_TOKEN_INVALID` and quota failures to `ACCOUNT_QUOTA`, fails without a credential as `ACCOUNT_SIGN_IN_REQUIRED`, publishes kind `account`, and owns the sign-out policy: it cancels its running Agents on `deepseek-account/signed-out` and registers a running-task report with the account service.

`@deepseek-ai/dsh-deepseek-account` releases request credentials. `resolveRequestCredential(url)` returns the `x-dsh-auth-token` header, the bare token, and a `reject()` that removes the grant while it still matches and contains storage failures; `registerRunningTaskReport(report)` feeds `hasRunningAccountTasks()`. The service inspects no Agents and depends on neither `dsh-agent` nor `dsh-llm`. The package lives in the `packages/account/` group under its unchanged name.

The web providers consume publications. `web-deepseek-api` builds each operation's ordered sources from `ctx.llm.routeCredential('deepseek-official')` and `routeCredential('deepseek-account')`: a route source sends an `api-key` grant's value as a bearer token and any other kind's headers unchanged, and invalidates through the grant's `reject()`. Without the API-key route it reads `DEEPSEEK_API_KEY` through the reference helpers; without the account route it asks the account service for the origin `DEEPSEEK_BASE_URL` names. `web-search-deepseek` uses the account credential of the initiating Session's route when that route publishes kind `account`, and the reference helpers otherwise. Neither web package depends on `llm-deepseek`, the route plugins, or the Loader, and `web-search-deepseek` no longer depends on the account service.

## Alternatives considered

**A `deepseek-auth` package holding the credential seam.** The seam needs a Service Definition only, no Cordis service, and that one Definition role belongs beside `LlmAdapter`; a package for an interface adds a dependency without an owner of behavior.

**A credential fingerprint in the published credential.** Consumers only send requests, so they need headers and a value; cache scoping by credential is the adapter's own concern, which the listing cache meets by hashing the headers it sends.

**A `credentials-env` provider instead of reference helpers.** A provider that reads the environment would change which composition is authoritative for every consumer; the helpers keep the launch-environment fallback local to the consumers that need it, so such a provider remains an independent option.

**The account service's inference origin for the web fallback without the account route.** Routing that fallback through `DEEPSEEK_BASE_URL` keeps the keyless billing snapshot and every documented deployment unchanged; the account service still refuses every origin but its own.

**Moving the account package into `identity/`.** That group defines anonymous, user-independent ids; a signed-in account is the opposite, so it gets a group of its own.

## Consequences

Adding a credential kind, or a consumer of a route's credential, touches one route plugin or one consumer, not the transport. The transport, the web providers, and the account service lose their cross-dependencies, and `hasRunningAccountTasks()` depends on a registered report rather than on Agents the account service can see. Consumers that construct `DeepSeekRequestAuth` supply a `value`; the removed helpers and the route plugins' config exports are gone, and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/llm-route-credential/guide.md) lists the replacements. A route's configuration failure reaches web consumers through `routeCredential()` as a thrown error, which they report as `WEB_PROVIDER_MISCONFIGURED`.
