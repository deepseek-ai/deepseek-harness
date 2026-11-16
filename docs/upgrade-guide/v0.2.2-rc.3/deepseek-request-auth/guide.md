---
kind: upgrade-guide
description: "DeepSeek model routes and web providers require the new dsh-deepseek-auth plugin; the llm-deepseek credential helpers, the dsh-llm API key check, the route plugins' config exports, and account Agent inspection are removed."
---

# DeepSeek consumers authenticate through ctx.deepseekAuth

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-deepseek-auth` provides `ctx.deepseekAuth`, which releases the API key or the account sign-in for one DeepSeek request. `@deepseek-ai/dsh-llm-deepseek-api-key`, `@deepseek-ai/dsh-llm-deepseek-account`, `@deepseek-ai/dsh-web-deepseek-api`, and `@deepseek-ai/dsh-web-search-deepseek` declare it as a peer dependency and start only in a composition that mounts it. The `base` and `sdk-minimal` bundles mount it.

`@deepseek-ai/dsh-llm-deepseek` no longer exports `resolveDeepSeekApiKey`, `deepSeekApiKeyConfigured`, `resolveDeepSeekAccountToken`, or `rejectDeepSeekAccountToken`. `DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` returns `DeepSeekRequestAuth | undefined`, `DeepSeekRequestAuth` gains an optional `revoked` signal, and the new `missingCredential` option names the missing-credential failure. `createModelListingCache` takes `credential(url)` returning request headers, and its `load` is optional.

`@deepseek-ai/dsh-llm` no longer exports `normalizeApiKey` and `assertUsableApiKey`. `@deepseek-ai/dsh-credentials` exports `normalizeApiKey(raw)`, `resolveCredentialRef(ctx, ref)`, and `credentialRefConfigured(ctx, ref)`.

`@deepseek-ai/dsh-llm-deepseek-api-key` no longer exports `plainOptions` and `resolveAdapterOptions`; `@deepseek-ai/dsh-llm-deepseek-account` no longer exports `plainAccountOptions` and `resolveAccountOptions`. The account route plugin cancels its running Agents after sign-out and registers a running-task report.

`@deepseek-ai/dsh-deepseek-account` adds Host-only `resolveRequestCredential(url)` and `registerRunningTaskReport(report)` and makes `resolveToken(url)` and `rejectToken(token)` private; `hasRunningAccountTasks()` answers from registered reports and no longer reads `ctx.agents`. A sign-out aborts released credentials' `revoked` signal, ending in-flight account requests: model requests outside a turn fail with `ACCOUNT_SIGN_IN_REQUIRED`, Search and Fetch with `WEB_PROVIDER_ERROR`. The package drops its `dsh-agent` and `dsh-llm` peer dependencies and moves from `packages/credentials/` to `packages/account/` under its unchanged name.

Without the account route, the Search and Fetch APIs send the account credential to the origin `DEEPSEEK_BASE_URL` names and reject a value that is not an HTTP(S) URL without embedded credentials. With `auto` billing, a `deepseek-account` or `deepseek-official` conversation whose route plugin is not mounted tries the API key, then the account credential. `DeepSeekSearchProviderOptions` replaces `resolveAccountToken`, `rejectAccountToken`, and `resolveApiKey` with `authorize(endpoint, signal)`.

## Migration

1. Add `- name: '@deepseek-ai/dsh-deepseek-auth'` to every composition that mounts one of the four plugins without the `base` or `sdk-minimal` bundle. Code that mounts them through `ctx.plugin()` mounts the package's default export first.
2. Replace the removed `llm-deepseek` helpers with `ctx.deepseekAuth.authorize({ consumer, accepts, destination })`: send the returned `headers`, call `reject()` after HTTP 401 when present, and end the request when `revoked` aborts. `candidates()` answers presence checks.
3. Replace `assertUsableApiKey` with `normalizeApiKey` from `@deepseek-ai/dsh-credentials`, and throw your own error for its `reason`.
4. In custom `DeepSeekAdapter` or `registerDeepSeekProvider` consumers, return `undefined` from `resolveAuth` when no credential exists and supply `missingCredential` for a route-specific failure. Pass credential headers, not a token, to `createModelListingCache`.
5. Replace imports of the route plugins' config exports with the plugins' own `Config`.
6. Make `deepseekAccount` stand-ins implement `resolveRequestCredential`, returning a `revoked` signal; stand-ins that supplied `ctx.agents` for `hasRunningAccountTasks()` register a report instead.
7. Update workspace references to `packages/account/deepseek-account`; the npm package name, Remote namespace, and configuration keys are unchanged.
8. Replace `resolveAccountToken`, `rejectAccountToken`, and `resolveApiKey` in `DeepSeekSearchProviderOptions` with `authorize`.
9. Type-check the callers, then send one DeepSeek model request and one web search in each changed composition.
