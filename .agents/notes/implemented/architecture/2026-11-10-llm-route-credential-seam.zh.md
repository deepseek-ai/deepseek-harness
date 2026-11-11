# Agent Note: Route credentials - DeepSeek model routes publish the credential consumers reuse

Status: implemented

[English](2026-11-10-llm-route-credential-seam.md) | 中文

## 问题

多个包共用同一份 DeepSeek 凭据，却没有所有者。协议传输层 `@deepseek-ai/dsh-llm-deepseek` 导出读取 `ctx.credentials`、启动环境和 `ctx.deepseekAccount` 的辅助函数，因此尽管传输层只发送路由交给它的请求头，它仍依赖两个凭据服务。两个路由插件通过这些函数解析凭据，并在 `resolveAuth` 内部抛出各自的凭据缺失错误。Search 与 Fetch API 提供方用路由包自己的配置解析函数，从路由包的 Loader 条目重新推导每条路由的基础地址和密钥引用，Messages 搜索则硬编码账号路由 id，因此两个 Web 包都依赖 `llm-deepseek`、两个路由插件和 Loader。位于所有消费方之下的账号服务拥有退登后的 Agent 取消逻辑，并和它仅仅使用的凭据库一起放在 `credentials/` 组。改变一条路由的鉴权方式要同时触及传输层、两个 Web 提供方及其测试。

## 决策

`@deepseek-ai/dsh-llm` 拥有 Service Definition。`LlmAdapter.routeCredential(provider)` 发布一个 `RouteCredential`：路由的 `kind`（可合并扩展，已声明 `api-key` 与 `account`）、解析后的 `baseURL`、用于诊断的可选凭据 `reference`、不读取值的存在性检查 `configured(endpoint)`，以及返回 `RouteCredentialGrant` 的 `resolve(endpoint, signal)`；授权包含协议 `headers`、供以其他方式呈现凭据的目标使用的裸 `value`，以及可选的 HTTP 401 `reject()`。`LlmRuntime.routeCredential(provider)` 转发给拥有该路由的适配器；未注册的路由回答 `undefined`，配置无法解析的路由则传播适配器的失败。适配器每次调用读取一代配置，与每次模型请求相同。

`@deepseek-ai/dsh-llm-deepseek` 不读取任何凭据。`DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` 返回授权或 `undefined`；`missingCredential(connection, provider)` 命名没有凭据时请求的失败，默认为 `MISSING_CREDENTIAL`；`credential` 声明发布的种类、引用和存在性检查。列表缓存以端点和凭据请求头的哈希划分作用域。

路由插件拥有凭据。`llm-deepseek-api-key` 通过 `@deepseek-ai/dsh-credentials` 新增的 `resolveCredentialRef` 和 `credentialRefConfigured` 读取密钥，二者把已挂载的凭据服务视为权威，仅在没有该服务时读取启动环境；它发布种类 `api-key` 并附带 `apiKeyEnv` 引用。`llm-deepseek-account` 读取 `ctx.deepseekAccount.resolveRequestCredential(endpoint)`，把 HTTP 401 映射为 `ACCOUNT_TOKEN_INVALID`、配额失败映射为 `ACCOUNT_QUOTA`，没有凭据时以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，发布种类 `account`，并拥有退登策略：在 `deepseek-account/signed-out` 时取消其运行中的 Agent，并向账号服务注册运行中任务报告。

`@deepseek-ai/dsh-deepseek-account` 释放请求凭据。`resolveRequestCredential(url)` 返回 `x-dsh-auth-token` 请求头、裸 token 和 `reject()`；`reject()` 仅在授权仍一致时删除它并隔离存储失败。`registerRunningTaskReport(report)` 为 `hasRunningAccountTasks()` 提供答案。该服务不检查任何 Agent，也不依赖 `dsh-agent` 或 `dsh-llm`。包以不变的名字位于 `packages/account/` 组。

Web 提供方消费这些发布的凭据。`web-deepseek-api` 从 `ctx.llm.routeCredential('deepseek-official')` 和 `routeCredential('deepseek-account')` 构造每次操作的有序凭据来源：路由来源把 `api-key` 授权的值作为 Bearer 令牌发送，其他种类的请求头原样发送，并通过授权的 `reject()` 作废。没有 API 密钥路由时，它通过引用函数读取 `DEEPSEEK_API_KEY`；没有账号路由时，它向账号服务索取发往 `DEEPSEEK_BASE_URL` 所指 origin 的凭据。`web-search-deepseek` 在发起会话的路由发布 `account` 种类时使用其账号凭据，否则使用引用函数。两个 Web 包都不再依赖 `llm-deepseek`、路由插件或 Loader，`web-search-deepseek` 也不再依赖账号服务。

## 考虑过的替代方案

**用一个 `deepseek-auth` 包承载凭据 seam。** 该 seam 只需要 Service Definition，不需要 Cordis 服务，而这一个 Definition 角色应与 `LlmAdapter` 放在一起；为一个接口建包只会增加一个没有行为所有者的依赖。

**在发布的凭据中加入凭据指纹。** 消费方只负责发送请求，因此只需要请求头和值；按凭据划分缓存作用域是适配器自己的事，列表缓存通过哈希它发送的请求头即可满足。

**用 `credentials-env` 提供方代替引用函数。** 读取环境的提供方会改变每个消费方眼中哪个组合具有权威性；引用函数把启动环境后备保留在需要它的消费方本地，使这样的提供方仍是独立的选项。

**没有账号路由时的 Web 后备使用账号服务的推理 origin。** 让该后备经由 `DEEPSEEK_BASE_URL` 可保持无密钥计费快照和所有已记录部署不变；账号服务仍拒绝除自身 origin 以外的一切来源。

**把账号包并入 `identity/`。** 该组定义匿名、不识别用户的 id；已登录账号与之相反，因此单独成组。

## 后果

新增凭据种类或路由凭据的消费方只触及一个路由插件或一个消费方，而不是传输层。传输层、Web 提供方和账号服务之间的交叉依赖消失，`hasRunningAccountTasks()` 依赖注册的报告而非账号服务可见的 Agent。构造 `DeepSeekRequestAuth` 的消费方需提供 `value`；被移除的辅助函数和路由插件的配置导出不复存在，[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/llm-route-credential/guide.zh.md)列出了替代方案。路由的配置失败通过 `routeCredential()` 以抛出错误的形式到达 Web 消费方，它们将其报告为 `WEB_PROVIDER_MISCONFIGURED`。
