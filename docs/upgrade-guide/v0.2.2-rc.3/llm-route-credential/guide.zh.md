---
kind: upgrade-guide
description: "DeepSeek 模型路由通过 ctx.llm.providerCredential() 发布自己的凭据；移除 llm-deepseek 的凭据辅助函数、路由插件的配置导出和账号服务对 Agent 的检查。"
---

# DeepSeek 路由发布 Web 消费方复用的凭据

[English](guide.md) | 中文

## 变更

`LlmAdapter.providerCredential(provider)` 与 `LlmRuntime.providerCredential(provider)` 把路由当前的凭据发布为 `ProviderCredential`：种类、解析后的基础地址、可选引用、`configured(endpoint)` 存在性检查，以及返回 `ProviderCredentialGrant` 的 `resolve(endpoint, signal)`，授权包含协议请求头、裸值、可选的 `reject()`，以及可选的 `revoked` 撤回信号。

`@deepseek-ai/dsh-llm-deepseek` 不再导出 `resolveDeepSeekApiKey`、`deepSeekApiKeyConfigured`、`resolveDeepSeekAccountToken` 和 `rejectDeepSeekAccountToken`。`DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` 返回 `DeepSeekRequestAuth | undefined`，且 `DeepSeekRequestAuth` 在 `headers` 之外要求 `value`；新增的 `missingCredential` 与 `credential` 选项分别命名凭据缺失的失败和发布的凭据。`createModelListingCache` 的 `credential(url)` 返回请求头，其 `load` 变为可选。

`@deepseek-ai/dsh-llm-deepseek-api-key` 不再导出 `plainOptions` 和 `resolveAdapterOptions`；`@deepseek-ai/dsh-llm-deepseek-account` 不再导出 `plainAccountOptions` 和 `resolveAccountOptions`。账号路由插件在退登后取消其运行中的 Agent，并注册运行中任务报告。

`@deepseek-ai/dsh-deepseek-account` 新增仅限 Host 的 `resolveRequestCredential(url)` 与 `registerRunningTaskReport(report)`，并将 `resolveToken(url)` 与 `rejectToken(token)` 改为私有；`hasRunningAccountTasks()` 根据注册的报告作答，不再读取 `ctx.agents`。退登会中止已释放凭据的 `revoked` 信号，从而结束在途的账号请求：回合之外的模型请求以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，Search 与 Fetch 以 `WEB_PROVIDER_ERROR` 失败。该包移除 `dsh-agent` 与 `dsh-llm` peer 依赖，并以不变的名字从 `packages/credentials/` 移至 `packages/account/`。`@deepseek-ai/dsh-credentials` 新增 `resolveCredentialRef(ctx, ref)` 与 `credentialRefConfigured(ctx, ref)`。

`@deepseek-ai/dsh-web-deepseek-api` 移除对 `dsh-llm-deepseek`、两个路由插件和 `cordis-plugin-loader` 的 peer 依赖；`@deepseek-ai/dsh-web-search-deepseek` 移除 `dsh-llm-deepseek` 与 `dsh-deepseek-account`，新增 `dsh-llm`。两者都通过 `ctx.llm.providerCredential()` 读取路由凭据，因此以 DeepSeek 路由 id 注册但不发布凭据、或发布另一种凭据的适配器视为没有路由。没有账号路由时，Search 与 Fetch API 把账号凭据发往 `DEEPSEEK_BASE_URL` 所指的 origin，并拒绝不是不含内嵌凭据的 HTTP(S) URL 的值。`DeepSeekSearchProviderOptions` 用 `resolveAccountCredential(endpoint)` 替换 `resolveAccountToken` 与 `rejectAccountToken`。

## 迁移

1. 替换被移除的 `llm-deepseek` 辅助函数：用 `@deepseek-ai/dsh-credentials` 的 `resolveCredentialRef` 与 `credentialRefConfigured` 读取密钥并用 `assertUsableApiKey` 校验；用 `ctx.deepseekAccount.resolveRequestCredential(url)` 读取账号凭据并通过返回的 `reject()` 作废。要复用已挂载路由的凭据和端点，调用 `ctx.llm.providerCredential(provider)`，并让每个请求受授权的 `revoked` 信号约束。
2. 在自定义的 `DeepSeekAdapter` 或 `registerDeepSeekProvider` 消费方中，没有凭据时让 `resolveAuth` 返回 `undefined`，为每个 `DeepSeekRequestAuth` 加上 `value`，为路由专属的失败提供 `missingCredential`，并声明 `credential` 以发布路由凭据。向 `createModelListingCache` 传递凭据请求头而不是 token。
3. 用路由插件自身的 `Config` 替换对其配置导出的导入，并从路由发布的凭据而非其解析函数读取端点。
4. 让账号路由或 Web 提供方使用的 `deepseekAccount` 替身实现 `resolveRequestCredential` 并返回 `revoked` 信号；为 `hasRunningAccountTasks()` 提供 `ctx.agents` 的替身改为注册报告。
5. 把工作区引用更新为 `packages/account/deepseek-account`；npm 包名、Remote 命名空间和配置键均不变。
6. 把 `DeepSeekSearchProviderOptions` 中的 `resolveAccountToken` 与 `rejectAccountToken` 替换为返回 `ProviderCredentialGrant` 的 `resolveAccountCredential`。
