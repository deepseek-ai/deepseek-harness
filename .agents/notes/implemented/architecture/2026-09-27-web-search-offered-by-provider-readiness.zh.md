# Agent Note: 仅在选中的提供方就绪时提供 web_search 与 web_fetch

Status: implemented

[English](2026-09-27-web-search-offered-by-provider-readiness.md) | 中文

## Problem

`dsh-tool-web` 在启用搜索时总会注册 `web_search`，而 [web 能力 seam 决策](2026-06-24-web-capability-seam.zh.md)让它在选中的提供方无法运行时仍然可见。DeepSeek Web 提供方只对 `deepseek-account` 路由上的模型请求使用 DeepSeek 账号 token 为操作鉴权；其他路由都需要已配置的 API 密钥。没有就绪检查时，API 密钥路由上没有密钥的会话会获得一个每次调用都以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败的工具。同一 Host 中的会话可以使用不同路由，一个会话可以在请求之间切换路由，而 Web 应用按 agent preset 只注册一次 `web_search`，因此任何注册层面的决定都无法与每个请求相符。`dsh-web-deepseek-api` 的 Fetch API 由用户与搜索提供方分别选择（[提供方选择](2026-10-29-web-provider-selection.zh.md)），它需要同一份凭据，因此这样的会话选中它时，还会获得一个每次调用都失败的 `web_fetch`。

## Decision

web 能力 seam 的每个角色各负责逐步骤检查的一部分：

- **Service Definition。** `WebSearchProvider` 与 `WebFetchProvider` 有一个可选的 `ready(llmProvider)`，回答为该对话路由上的模型请求发起的操作是否有可发送的凭据。它只检查配置，不发起网络调用。`ctx.web.searchReady(llmProvider?)` 与 `ctx.web.fetchReady(llmProvider?)` 按与 `search()`、`fetch()` 相同的规则解析提供方并返回其回答。没有 `ready()` 的提供方视为就绪；选择失败时回答 true，因为对应操作会把该失败报告为结构化 `WebError`。
- **Service Provider。** 每个 DeepSeek 提供方都按其操作解析凭据的顺序检查凭据。`dsh-web-search-deepseek` 在 `deepseek-account` 路由上检查 `ctx.deepseekAccount.resolveToken()` 是否为其 Messages 端点返回 token，然后检查其字面 `apiKey` 或 `apiKeyEnv` 引用。`dsh-web-deepseek-api` 的 Search 与 Fetch API 提供方解析与操作相同的方案（[凭据解析](2026-10-29-web-provider-selection.zh.md)）：在 YAML 中设置了单独字段的能力只检查其 `*ApiKeyEnv` 下的密钥；否则，在账号路由上且账号模型路由已挂载时，该路由 `/v1/tools` 基础地址的 token 算数，然后是 `deepseek-official` 路由的密钥，没有该路由时为 `DEEPSEEK_API_KEY`。`ctx.credentials.describe()` 报告其引用已配置时（没有该服务时，启动环境中存在该变量），密钥即算存在；这些存在性检查由[共享凭据函数](../../../../packages/llm/llm-deepseek/src/credential.ts)执行。读取账号 token 或凭据存储失败时回答 false，因为操作会在该次读取上失败，而不会尝试下一种凭据。提供方不点名任何工具或提示词段落。
- **Consumer。** `dsh-tool-web` 注册 `web_search` 与 `web_fetch` 时各带一个[步骤激活条件](../../../../packages/core/tools/README.zh.md#conditional-tools)，以该步骤模型选择的路由询问 `ctx.web.searchReady()` 与 `ctx.web.fetchReady()`。agent loop 在组装该步骤之前解析各条件，因此声明的工具、`tool:web_search` 与 `tool:web_fetch` 提示词段落、PTC 程序绑定与派发都读取同一个准入集合。

路由只决定是否先检查账号 token 再检查 API 密钥，这发生在 `deepseek-account` 路由上；API 密钥在每条路由上都算数，因此只要配置了 DeepSeek 密钥，使用其他提供方模型的对话也会获得 DeepSeek Web 工具。在 YAML 中设置了单独字段的 Search 或 Fetch API 能力不看路由，恰在其自身密钥已配置时就绪。

只看凭据是否存在：不读取 API 密钥的值，也不访问任何端点，因此错误的密钥，或不提供原生 `web_search_20250305` 服务器工具的端点，仍会让该工具保持准入。未准入某个 Web 工具的步骤也会以 `UNKNOWN_TOOL` 拒绝对它的调用，因此模型重复先前的调用也到达不了任何提供方；在模型步骤之外发起的操作在运行时解析凭据，没有凭据时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。

请求头记录组装后的工具，因此 agent loop（智能体循环）通过工具注册表更新宣告每次变化。路由切换、存储密钥或删除密钥都会改变下一个请求；DeepSeek 路由以延迟加载的新增方式载入重新提供的工具，不支持工具更新的路由则接收完整工具列表。

## Alternatives considered

**让 DeepSeek 提供方在自己的 assemble 监听器中移除 `web_search`。** seam 保持不变，但提供方因此要点名另一个包的工具、提示词段落与 PTC 传输工具；而且即使部署选择了另一个搜索成功的提供方（例如插件注册的提供方），它也会移除该工具。

**扩展 `available()`。** 它是同步的且不接收请求，而这项检查要读取异步凭据存储，并取决于请求的路由。依赖路由的 `available()` 还会让提供方选择取决于对话。

**从会话最近的 `request/context` 事件读取路由，而不是传入路由。** 该事件记录的是上一个请求，因此新会话的首个请求，以及模型切换后的首个请求，会按错误的路由判断，或根本没有路由可用。

**在 `dsh-tool-web` 中注册或注销 `web_search`。** 注册由同一 agent preset 的所有会话共享，而凭据取决于每个请求的路由。注销还会使点名 `web_search` 的 `toolOrder` 条目和 subagent `toolFilter` 限制失败。

**从组装好的请求中移除 `web_search`。** `system-prompt/assemble` 监听器可以删掉该声明及其段落，但工具仍可执行，因此模型重复先前的调用时仍会运行它，PTC 程序也仍能绑定它。提示词组装也已不再携带工具声明。

**只在 DeepSeek 账号路由上提供搜索。** 账号 token 只对官方端点签发，因此网关的密钥不可能到达 DeepSeek。但所有发行 profile 的默认路由都是 `deepseek-official`，搜索会因此默认关闭，连官方 API 密钥的情况也一并关闭。

**除非搜索有自己的密钥，否则不向其他提供方的对话提供这些工具。** 其他模型对话中的搜索会由 DeepSeek 密钥计费，但 DeepSeek 搜索本就是该密钥付费使用的服务之一，配置了它的用户也期望无论用哪个模型对话，搜索都能用。Search 与 Fetch API 发送聊天路由自己的密钥，设置页把旧版 Messages 搜索的密钥存在 `apiKeyEnv` 指向的引用下，默认是聊天路由也在读取的 `DEEPSEEK_API_KEY`，因此撤下工具会让已配置的密钥无法服务其他模型；再加一个开放这些路由的 `routes` 配置项，只会让用户多找一样东西。

**比较官方聊天路由的端点与 Web 端点，二者不同时撤下工具。** 这能让网关的密钥远离 DeepSeek，但也会让经代理或开发端点对话、而密钥能被 Web 端点接受的用户失去网页工具。Search 与 Fetch API 改为从其所发送密钥的路由的 origin 推导端点，因此密钥与端点来自同一条路由；旧版 Messages 搜索保留自己的端点，网关用户的搜索会在那里失败。

**保持工具可见，在执行时失败。** 模型会把一次调用花在无法鉴权的搜索上，并且每次尝试都会重复失败。

**提供工具前探测密钥或端点。** 每个模型请求都发起一次网络请求会增加延迟与成本；用户控制的是配置本身，而不是它在那一刻是否有效。

## Consequences

`dsh-web` 增加以下公共成员：两个提供方接口上可选的 `ready()`、`WebRuntime.searchReady()` 与 `WebRuntime.fetchReady()`。每个就绪方法都是其唯一消费方所需的最小查询，这正是[观测接口决策](../../archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.md)允许状态查询回归的方式；它们既不报告可用性，也不报告选择失败。HTTP 抓取提供方没有实现 `ready()`，因此只要选中 HTTP 抓取，`web_fetch` 就始终准入。未准入某个 Web 工具的步骤，其 PTC 程序绑定中也没有它。无法提供原生服务器工具的端点仍会让工具保持准入，并使每次调用失败。在路由不变时移除工具会改变声明的工具，并使提示词缓存失效一次；模型切换本身已经使缓存失效。其他提供方对话中的搜索与抓取由配置的 DeepSeek 密钥计费。官方路由经网关对话的部署，对 Search 与 Fetch API 会把网关的密钥发往该网关 origin 加 `/v1/tools`，对旧版 Messages 搜索则发往配置的 Messages 端点（默认是官方端点），除非该端点接受这个密钥，否则每次搜索都会失败。Search 与 Fetch API 通过模型提供方目录读取 DeepSeek 模型路由的 Loader 条目。

单元测试分别固定每个角色：[web.spec.ts](../../../../packages/web/web/tests/web.spec.ts) 覆盖 `searchReady()` 与 `fetchReady()` 询问哪个提供方以及选择失败时的回答，[deepseek.spec.ts](../../../../packages/web/web-search-deepseek/tests/deepseek.spec.ts) 与 [credential-resolution.spec.ts](../../../../packages/web/web-deepseek-api/tests/credential-resolution.spec.ts) 覆盖 `ready()` 在账号路由与其他路由上的每种凭据情况，包括就绪判断与每次操作一致，[tool-web.spec.ts](../../../../packages/web/tool-web/tests/tool-web.spec.ts) 通过真实的提示词、工具与执行器服务解析两个工具的步骤准入，包括在撤下该工具的步骤中调用它时以 `UNKNOWN_TOOL` 拒绝。在真实组合中，发行版 headless 无密钥冒烟测试与 `web-search-unconfigured` 录制会话快照的搜索密钥引用都未设置，二者固定了搜索工具的撤下行为。快照回放提供占位 DeepSeek 密钥，因此其工具列表不依赖运行环境；借助该密钥，`pi-ai-conversation-updates` 中 pi-ai 路由上的对话保留 `web_search`。
