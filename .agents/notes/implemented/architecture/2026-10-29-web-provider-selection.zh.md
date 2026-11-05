# Agent Note: Web 提供方选择——基于已注册提供方的独立下拉框

Status: implemented

[English](2026-10-29-web-provider-selection.md) | 中文

## 问题

Web 服务通过 `web.searchProvider` 和 `web.fetchProvider` 两个独立字段分别选择搜索与抓取提供方。用一个设置控件同时写入两者，会把抓取的计费和目标访问策略绑在搜索选择上；只提供已知 DeepSeek 选项的控件，也无法选用其他插件注册的提供方。基于已注册提供方的选择器需要 Host 报告这些提供方，而 [Web 能力 seam](2026-06-24-web-capability-seam.zh.md) 没有可供复用的可用性观察接口。Messages 搜索每次查询都会发起一次辅助模型请求，而 [Search API](../feature/2026-10-15-deepseek-search-fetch-api.zh.md) 能直接返回结构化来源。Search 与 Fetch API 还需要 DeepSeek 凭据；为它们单独设置凭据，会让每个用户都要把它与自己对话所用的模型提供方对齐。

## 决策

用户从 Host 已注册的提供方列表中分别选择搜索和抓取提供方。内置组合将搜索设为 Search API，将抓取设为本地 HTTP 抓取；DeepSeek Search 与 Fetch API 跟随会话的 DeepSeek 凭据。

### 已注册的提供方可观察，可用性不可观察

`WebSearchProvider` 和 `WebFetchProvider` 带有可选的 `title`（提供方的显示名称）和可选的多语言 `description`（说明该提供方适合什么、有什么代价或做不到什么）。`ctx.web.listProviders()` 返回 `{ search, fetch }`，二者均为按注册顺序排列的 `{ id, title?, description? }` 列表，`web` Remote namespace 将其暴露为 `web/listProviders`。每次注册和注销都会在注册表变更后触发无载荷的 `web/providers-changed` 事件；Web 服务会隔离监听器异常，因此观察者无法阻断注册表变更。[dsh-api-remotes](../../../../packages/api/remotes/README.zh.md) 挂载该 namespace 并转发该事件，Client 在收到通知和重连后重新读取列表。

列表包含 `available()` 返回 false 的提供方。选择器展示的是可固定选用的项，包括用户尚未配置凭据的提供方；而可用性取决于会话的模型路由、凭据状态等单次请求条件。因此可用性仍是执行期结果：`search()` 和 `fetch()` 在调用时解析所配置的提供方并抛出结构化 `WebError`，与 seam 记录一致。工具层仍从不枚举提供方。

### 分别选择

「网页搜索与获取」页由 Search 下拉框写入 `web.searchProvider`，由 Fetch 下拉框写入 `web.fetchProvider`。每个下拉框以 `title`（缺省时用 `id`）列出该能力的所有已注册提供方，因此插件提供方无需修改页面即可出现，且 Host 未注册的已选 id 仍会照常显示。官方提供方不注册 `title`，由页面用自己的语言字典命名，并按固定顺序排在最前：搜索依次为 Search API（`deepseek-search-api`）与 Messages 搜索（`deepseek-official`），抓取依次为本地 HTTP 抓取（`http`）和 Fetch API（`deepseek-fetch-api`）。其他提供方按 Host 注册顺序排列。选择部署组合的默认提供方会清除已保存的覆盖值，而非冗余保存一份副本。[设置页 README](../../../../packages/client/ui-settings-web-search/README.zh.md) 负责页面控件说明。

所有已注册的提供方都会列出；提供方没有可以把自己排除在下拉框之外的标志。本 Note 取代了 [Search 与 Fetch API 决策](../feature/2026-10-15-deepseek-search-fetch-api.zh.md)对「在设置页用下拉框列出所有已注册的提供方」的否决。独立的下拉框必须提供其他插件注册的提供方，而列出提供方所需的展示元数据只是可选的 `title` 和 `description`。说明放在注册信息里而不是页面词典里，这样官方与插件提供方都通过同一个字段说明自己，新提供方无需修改页面即可说明其取舍。被否决的通用编辑表单仍然成立：该页面只编辑 DeepSeek 提供方的设置，其他提供方保留各自的设置页。

Search 与 Fetch API 读取同一个 `web-deepseek-api` namespace，并各自解析自己的凭据和端点，见下一节。Messages 搜索从 `web-search-deepseek` 读取独立的端点和密钥引用。

### 凭据解析

Search 与 Fetch 各有一个计费方式设置 `web-deepseek-api.searchBilling` 或 `fetchBilling`，设置页在选中的 API 下方以**计费方式**下拉框编辑它。默认值 `auto` 跟随会话的 DeepSeek 凭据；`account` 只发送已登录账号的令牌，`api-key` 只发送 API 密钥，都不回退到另一种凭据。会话的路由是发起会话最近一次请求上下文的 `provider`，账号退出登录读取的也是它；`ready()` 使用正在准备的模型请求的路由，因此就绪判断与执行解析出相同的方案。

账号令牌是 `ctx.deepseekAccount` 为模型提供方目录列出的入口根部活动 `@deepseek-ai/dsh-llm-deepseek-account` Loader 条目的 origin 加 `/v1/tools` 下的请求端点给出的令牌；没有该条目时使用该路由默认基础地址的 origin。HTTP 401 会作废该令牌。`auto` 计费在 `deepseek-account` 路由上，若存在该条目且取得令牌，操作发送账号令牌。其他所有 `auto` 操作，包括账号会话中没有登录或没有令牌的操作，都把 `deepseek-official` 的活动 `@deepseek-ai/dsh-llm-deepseek-api-key` 条目的 `apiKeyEnv` 下的密钥（用该包自己的解析函数解析，包括 `DEEPSEEK_BASE_URL`）发往该路由基础地址的 origin 加 `/v1/tools`；没有该条目时，把 `DEEPSEEK_API_KEY` 发往 `https://api.deepseek.com/v1/tools`。`auto` 计费在两个 DeepSeek 路由之外的路由上或会话之外，没有配置密钥的操作改为发送账号令牌，因此已登录但没有密钥的用户在其他模型提供方的会话中仍可使用网页工具；在 `deepseek-official` 路由上从不发送令牌，因为该会话按 API 密钥计费。未登录的账号会话发送 API 密钥，网页工具因此在其中仍然可用。因此只有 `DEEPSEEK_API_KEY` 的用户（包括所有 headless、SDK 与 ACP 运行）默认即可搜索和抓取，通过模型提供方基础地址设置的网关或内部部署也在同一 origin 上提供 Web 访问。缺少凭据时，该能力未就绪，操作以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，指引信息按计费方式点名账号登录、模型页面与该引用，以及计费方式字段。已挂载、但其解析函数拒绝其设置的路由条目不视为不存在：需要该路由的操作未就绪，并在读取依赖该路由的凭据前以 `WEB_PROVIDER_MISCONFIGURED` 失败，不再尝试后续来源，也不发送请求，因此网关设置出错时请求不会被改发到官方端点。

在 YAML 中设置了非空 `searchBaseURL` 或 `searchApiKeyEnv`（Fetch 为 `fetchBaseURL` 或 `fetchApiKeyEnv`）的能力，则无论计费方式如何，始终把其 `*ApiKeyEnv`（未设置时为 `DEEPSEEK_API_KEY`）下的密钥发往其 `*BaseURL`（未设置时为官方基础地址），从不发送账号令牌，因此内网或第三方端点只收到为它选择的密钥。每个能力有自己的字段，因为一个部署可以由不同网关提供搜索和抓取。这些字段只能在 YAML 中设置，空值视为未设置。schema 之外字段的已保存值，包括 `baseURL`、`apiKeyEnv` 和 `apiKey`，可以加载而不产生 schema 错误，且不生效。

`@deepseek-ai/dsh-llm-deepseek` 的[凭据函数](../../../../packages/llm/llm-deepseek/src/credential.ts)为 DeepSeek 模型路由、Messages 搜索以及 Search 与 Fetch API 读取并校验 API 密钥、检查密钥是否存在、取得账号令牌，因此每个 DeepSeek 请求都以同一方式读取凭据库；账号模型路由、Messages 搜索以及 Search 与 Fetch API 还会作废被 HTTP 401 拒绝的令牌。内置配置不需要按 profile 覆盖凭据，因为只要 `DEEPSEEK_API_KEY` 或 DeepSeek API 密钥路由有密钥，API 密钥路径就能工作。

### 默认值与已保存的选择

[base 组合](../../../../packages/bundle/base/cordis.patch.yml)设置 `searchProvider: deepseek-search-api` 和 `fetchProvider: http`。搜索默认使用 Search API，因为它返回来源时无需 Harness 发起辅助模型请求。抓取默认使用本地 HTTP 抓取，因为它没有按次的 API 费用，执行 Harness 自身的 URL 校验和资源限制，并且可以访问内网和本地地址。Fetch API 仍可在下拉框中直接选择。

已保存的选择——无论位于设置文档还是部署自身的组合中——优先于内置默认值，升级不会改写它。执行时从不替换选择：所选提供方缺失、不可用或失败时，操作以结构化错误失败，不会回退到其他搜索或抓取提供方。回退会把查询和凭据发往用户未选择的端点，并在不提示的情况下改变计费。

### 旧版 Messages 搜索

DeepSeek Messages 搜索提供方仍以 **DeepSeek（旧版）**提供。已保存的 `web.searchProvider: deepseek-official`（或 `DSH_WEB_SEARCH_PROVIDER=deepseek-official`）会选中它，因此网关支持 Messages 搜索但不提供 `/v1/tools` 的用户可以保留可用的提供方。

Messages 提供方负责声明并写入 `web/deepseek-search-llm-request`。声明和载荷保持与已发布会话兼容；Search 与 Fetch API 包既不声明也不写入这一辅助事件。

## 考虑过的替代方案

**保留一个同时切换两个 API 的开关。** 它让使用 Fetch API 无需修改配置，但把抓取的计费和目标访问策略绑在搜索选择上，也无法表达其他插件注册的提供方。

**按可用性过滤列表，或在每个条目中加入可用性。** 过滤后的列表恰好会在凭据缺失时隐藏提供方，而这正是用户需要选择并配置它的时候。可用性还取决于请求的模型路由和凭据状态，列表中的布尔值可能与实际执行结果不一致。已归档的[观察面决策](../../archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.md)只允许引入消费方实际读取的最小信号；下拉框只读取注册情况。

**在 Client 中维护固定的提供方目录。** Client 会把 Host 未注册的 id 当作正常选项展示，且永远无法展示插件在运行时注册的提供方。

**在变更事件中携带提供方列表。** 无载荷事件让初次加载、变更通知和断线重连共用同一条读取路径，Client 无需为事件载荷与并发读取结果排序。

**把显示名称放在 Client 或单独的 Host 注册表中。** 注册插件最清楚自身提供方的名称；拆成独立映射会让提供方与其标签各自独立注册或注销。

**所选提供方失败时回退到其他提供方。** 回退会掩盖网关和凭据的配置错误，将查询发往第二个服务，并在未经用户选择的情况下改变请求的费用。

**移除 Messages 搜索，让已保存的 `deepseek-official` 选中 Search API。** 网关可能支持 Messages 搜索，却没有 Search API 路由。保留旧版提供方可以保留这一选择，而不改变其协议和计费。

**抓取也默认使用 Fetch API。** 它会给每次抓取增加按次费用，并把页面抓取和目标访问策略交给服务端，由服务端而不是用户的机器发起抓取。

**在设置页为每个能力选择一种凭据来源**，下拉框列出已配置的 DeepSeek 模型提供方，外加自定义密钥和基础地址，来源之间不回退。这样可见的设置就能说明全部规则，但配置面过大，用户难以理解：每个能力都多出一个凭据下拉框，用户必须让它与自己对话所用的模型提供方保持一致；在账号路由上对话的已登录用户在修改设置前没有网页工具。默认的 `auto` 计费无需配置即跟随会话的凭据，计费方式下拉框只提供两种 DeepSeek 凭据，与模型提供方不同的端点由只能在 YAML 中设置的单独字段覆盖。

**Search 与 Fetch 共用一个自定义密钥和基础地址。** 它无法表达由不同网关分别提供两个 API 的部署。

**账号会话未登录时直接失败，而不是发送 API 密钥。** 这样账号路由永远不会消耗 API 密钥，但即使配置了 DeepSeek API 密钥，未登录的账号会话也会失去网页工具。

**只要用户已登录就发送账号令牌，不论会话的路由。** 这会让在 API 密钥路由或其他提供方上进行的会话把 Web 访问记到账号上，而用户并没有为这些会话这样选择。

## 影响

没有已保存搜索选择的用户通过 Search API 搜索：查询发往会话的 DeepSeek 凭据所选的 Search 端点，每次计为一次 Search API 请求，并且除非关闭 `sendOriginalQuestion`，还会把最近一条用户提示的至多 128 个字符作为 `ori_question` 发送。网关没有 `/v1/tools` 路由的部署会遇到搜索失败，直到选择 Messages 搜索，或把 `searchBaseURL` 设为提供这些路由的基础地址。已保存的 `deepseek-official` 选择使用 Messages 搜索。没有已保存抓取选择的用户通过本地 HTTP 抓取。已登录但没有 API 密钥的用户在 `auto` 计费下，除 DeepSeek API 密钥路由上的会话外，都可以使用 DeepSeek 网页搜索；[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.2/web-search-credential-modes/guide.zh.md)列出了每种受影响的配置。

插件提供方（包括在创作模式下编写的提供方）一经注册，就会以其 `title` 出现在对应的下拉框中。下拉框可能提供在当前请求中无法运行的提供方；失败会在执行搜索或抓取时出现。每次注册表变更会在每个观察它的 Client 中产生一次转发事件和一次列表读取。

## 验证

[web.spec.ts](../../../../packages/web/web/tests/web.spec.ts) 覆盖列表内容与顺序、标题、注册与撤销后的事件、重复注册被拒绝时不触发事件，以及监听器失败的隔离。[deepseek.spec.ts](../../../../packages/web/web-search-deepseek/tests/deepseek.spec.ts) 覆盖独立的 Messages 提供方，[credential-resolution.spec.ts](../../../../packages/web/web-deepseek-api/tests/credential-resolution.spec.ts) 针对两个能力覆盖账号路由上的账号令牌及其在 HTTP 401 后被作废、未登录时回退到 API 密钥、官方、非 DeepSeek 和会话之外的操作使用路由密钥与端点、DeepSeek 路由之外没有密钥时回退到账号、在每个路由上只用账号或只用 API 密钥的计费、单独字段优先于计费方式、没有该路由时使用 `DEEPSEEK_API_KEY` 与官方基础地址、从不发送令牌的 YAML 单独字段、两个能力相互独立、就绪判断与每次操作一致，以及被忽略的已移除字段；[composition.spec.ts](../../../../packages/web/web-deepseek-api/tests/composition.spec.ts) 通过 Loader 启动真实的模型路由。[remote-events.host.spec.ts](../../../../packages/api/remotes/tests/remote-events.host.spec.ts) 覆盖事件转发，[base.spec.ts](../../../../packages/bundle/base/tests/base.spec.ts) 固定内置默认值。设置页的 controller 与 card 测试以及[插件配置浏览器场景](../../../../apps/web/tests/plugin-config.e2e.ts)覆盖下拉框内容、Search 与 Fetch 的分别选择、DeepSeek API 的计费方式下拉框，以及各提供方保留的设置。
