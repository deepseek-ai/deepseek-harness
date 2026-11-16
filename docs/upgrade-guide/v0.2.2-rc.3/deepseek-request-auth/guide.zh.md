---
kind: upgrade-guide
description: "DeepSeek 模型路由和 Web 提供方要求挂载新的 dsh-deepseek-auth 插件；移除 llm-deepseek 的凭据辅助函数、dsh-llm 的 API 密钥检查、路由插件的配置导出和账号服务对 Agent 的检查。"
---

# DeepSeek 消费方通过 ctx.deepseekAuth 鉴权

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-deepseek-auth` 提供 `ctx.deepseekAuth`，为一次 DeepSeek 请求释放 API 密钥或账号登录凭据。`@deepseek-ai/dsh-llm-deepseek-api-key`、`@deepseek-ai/dsh-llm-deepseek-account`、`@deepseek-ai/dsh-web-deepseek-api` 和 `@deepseek-ai/dsh-web-search-deepseek` 把它声明为对等依赖（peer dependency），并且只在挂载了它的组合中启动。`base` 与 `sdk-minimal` 两个组合包挂载它。

`@deepseek-ai/dsh-llm-deepseek` 不再导出 `resolveDeepSeekApiKey`、`deepSeekApiKeyConfigured`、`resolveDeepSeekAccountToken` 和 `rejectDeepSeekAccountToken`。`DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` 返回 `DeepSeekRequestAuth | undefined`，`DeepSeekRequestAuth` 新增可选的 `revoked` 信号，新增的 `missingCredential` 选项命名凭据缺失的失败。`createModelListingCache` 的 `credential(url)` 返回请求头，其 `load` 变为可选。

`@deepseek-ai/dsh-llm` 不再导出 `normalizeApiKey` 和 `assertUsableApiKey`。`@deepseek-ai/dsh-credentials` 导出 `normalizeApiKey(raw)`、`resolveCredentialRef(ctx, ref)` 和 `credentialRefConfigured(ctx, ref)`。

`@deepseek-ai/dsh-llm-deepseek-api-key` 不再导出 `plainOptions` 和 `resolveAdapterOptions`；`@deepseek-ai/dsh-llm-deepseek-account` 不再导出 `plainAccountOptions` 和 `resolveAccountOptions`。账号路由插件在退登后取消其运行中的 Agent，并注册运行中任务报告。

`@deepseek-ai/dsh-deepseek-account` 新增仅限 Host 的 `resolveRequestCredential(url)` 与 `registerRunningTaskReport(report)`，并将 `resolveToken(url)` 与 `rejectToken(token)` 改为私有；`hasRunningAccountTasks()` 根据注册的报告作答，不再读取 `ctx.agents`。退登会中止已释放凭据的 `revoked` 信号，从而结束在途的账号请求：回合之外的模型请求以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，Search 与 Fetch 以 `WEB_PROVIDER_ERROR` 失败。该包移除 `dsh-agent` 与 `dsh-llm` 对等依赖，并以不变的名字从 `packages/credentials/` 移至 `packages/account/`。

没有账号路由时，Search 与 Fetch API 把账号凭据发往 `DEEPSEEK_BASE_URL` 所指的 origin，并拒绝不是不含内嵌凭据的 HTTP(S) URL 的值。在 `auto` 计费下，`deepseek-account` 或 `deepseek-official` 上的会话在其路由插件未挂载时先尝试 API 密钥，再尝试账号凭据。`DeepSeekSearchProviderOptions` 用 `authorize(endpoint, signal)` 替换 `resolveAccountToken`、`rejectAccountToken` 与 `resolveApiKey`。

## 迁移

1. 凡是不经 `base` 或 `sdk-minimal` 组合包而挂载上述四个插件之一的组合，都加入 `- name: '@deepseek-ai/dsh-deepseek-auth'`。用 `ctx.plugin()` 挂载它们的代码先挂载该包的默认导出。
2. 用 `ctx.deepseekAuth.authorize({ consumer, accepts, destination })` 替换被移除的 `llm-deepseek` 辅助函数：发送返回的 `headers`，存在 `reject()` 时在 HTTP 401 之后调用它，并在 `revoked` 中止时结束请求。存在性检查使用 `candidates()`。
3. 用 `@deepseek-ai/dsh-credentials` 的 `normalizeApiKey` 替换 `assertUsableApiKey`，并依据它的 `reason` 抛出自己的错误。
4. 在自定义的 `DeepSeekAdapter` 或 `registerDeepSeekProvider` 消费方中，没有凭据时让 `resolveAuth` 返回 `undefined`，并为路由专属的失败提供 `missingCredential`。向 `createModelListingCache` 传递凭据请求头而不是 token。
5. 用路由插件自身的 `Config` 替换对其配置导出的导入。
6. 让 `deepseekAccount` 替身实现 `resolveRequestCredential` 并返回 `revoked` 信号；为 `hasRunningAccountTasks()` 提供 `ctx.agents` 的替身改为注册报告。
7. 把工作区引用更新为 `packages/account/deepseek-account`；npm 包名、Remote 命名空间和配置键均不变。
8. 把 `DeepSeekSearchProviderOptions` 中的 `resolveAccountToken`、`rejectAccountToken` 与 `resolveApiKey` 替换为 `authorize`。
9. 对调用方做类型检查，然后在每个改动过的组合里各发起一次 DeepSeek 模型请求和一次 Web 搜索。
