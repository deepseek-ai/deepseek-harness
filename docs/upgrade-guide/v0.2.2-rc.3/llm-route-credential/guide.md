---
kind: upgrade-guide
description: "DeepSeek model routes publish their credential through ctx.llm.providerCredential(); the llm-deepseek credential helpers, the route plugins' config exports, and account Agent inspection are removed."
---

# DeepSeek routes publish the credential web consumers reuse

English | [中文](guide.zh.md)

## Change

`LlmAdapter.providerCredential(provider)` and `LlmRuntime.providerCredential(provider)` publish a route's current credential as a `ProviderCredential`: kind, resolved base URL, optional reference, a `configured(endpoint)` presence check, and `resolve(endpoint, signal)` returning a `ProviderCredentialGrant` with protocol headers, the bare value, an optional `reject()`, and an optional `revoked` withdrawal signal.

`@deepseek-ai/dsh-llm-deepseek` no longer exports `resolveDeepSeekApiKey`, `deepSeekApiKeyConfigured`, `resolveDeepSeekAccountToken`, or `rejectDeepSeekAccountToken`. `DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` returns `DeepSeekRequestAuth | undefined`, and `DeepSeekRequestAuth` requires `value` beside `headers`; the new `missingCredential` and `credential` options name the missing-credential failure and the published credential. `createModelListingCache` takes `credential(url)` returning request headers, and its `load` is optional.

`@deepseek-ai/dsh-llm-deepseek-api-key` no longer exports `plainOptions` and `resolveAdapterOptions`; `@deepseek-ai/dsh-llm-deepseek-account` no longer exports `plainAccountOptions` and `resolveAccountOptions`. The account route plugin cancels its running Agents after sign-out and registers a running-task report.

`@deepseek-ai/dsh-deepseek-account` adds Host-only `resolveRequestCredential(url)` and `registerRunningTaskReport(report)` and makes `resolveToken(url)` and `rejectToken(token)` private; `hasRunningAccountTasks()` answers from registered reports and no longer reads `ctx.agents`. A sign-out aborts released credentials' `revoked` signal, ending in-flight account requests: model requests outside a turn fail with `ACCOUNT_SIGN_IN_REQUIRED`, Search and Fetch with `WEB_PROVIDER_ERROR`. The package drops its `dsh-agent` and `dsh-llm` peer dependencies and moves from `packages/credentials/` to `packages/account/` under its unchanged name. `@deepseek-ai/dsh-credentials` adds `resolveCredentialRef(ctx, ref)` and `credentialRefConfigured(ctx, ref)`.

`@deepseek-ai/dsh-web-deepseek-api` drops its peer dependencies on `dsh-llm-deepseek`, both route plugins, and `cordis-plugin-loader`; `@deepseek-ai/dsh-web-search-deepseek` drops `dsh-llm-deepseek` and `dsh-deepseek-account` and adds `dsh-llm`. Both read route credentials through `ctx.llm.providerCredential()`, so an adapter registered under a DeepSeek route id that publishes no credential, or a credential of the other kind, counts as no route. Without the account route, the Search and Fetch APIs send the account credential to the origin `DEEPSEEK_BASE_URL` names and reject a value that is not an HTTP(S) URL without embedded credentials. `DeepSeekSearchProviderOptions` replaces `resolveAccountToken` and `rejectAccountToken` with `resolveAccountCredential(endpoint)`.

## Migration

1. Replace the removed `llm-deepseek` helpers: read keys with `resolveCredentialRef` and `credentialRefConfigured` from `@deepseek-ai/dsh-credentials` and validate them with `assertUsableApiKey`; read account credentials with `ctx.deepseekAccount.resolveRequestCredential(url)` and invalidate through the returned `reject()`. To reuse a mounted route's credential and endpoint, call `ctx.llm.providerCredential(provider)`, and run each request under the grant's `revoked` signal.
2. In custom `DeepSeekAdapter` or `registerDeepSeekProvider` consumers, return `undefined` from `resolveAuth` when no credential exists, add `value` to every `DeepSeekRequestAuth`, supply `missingCredential` for a route-specific failure, and declare `credential` to publish the route's credential. Pass credential headers, not a token, to `createModelListingCache`.
3. Replace imports of the route plugins' config exports with the plugins' own `Config`, and read a route's endpoint from its published credential instead of its resolver.
4. Make `deepseekAccount` stand-ins used by the account route or the web providers implement `resolveRequestCredential`, returning a `revoked` signal; stand-ins that supplied `ctx.agents` for `hasRunningAccountTasks()` register a report instead.
5. Update workspace references to `packages/account/deepseek-account`; the npm package name, Remote namespace, and configuration keys are unchanged.
6. Replace `resolveAccountToken` and `rejectAccountToken` in `DeepSeekSearchProviderOptions` with `resolveAccountCredential` returning a `ProviderCredentialGrant`.
