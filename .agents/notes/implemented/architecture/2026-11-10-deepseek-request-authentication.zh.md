# Agent Note: DeepSeek request authentication - one service releases the API key or the account sign-in to every DeepSeek consumer

Status: implemented

[English](2026-11-10-deepseek-request-authentication.md) | 中文

## 问题

DeepSeek 的 API 接受两种凭据：API 密钥和账号登录。每个 API 接受其中一种或两种：每条模型路由的 Messages、Files 和模型列表请求只带一种，Search 与 Fetch 两种都接受，DeepSeek 还在逐个为其他 API 增加账号鉴权。在两种凭据之间做选择这件事没有所有者。协议传输层 `@deepseek-ai/dsh-llm-deepseek` 导出读取 `ctx.credentials`、启动环境和 `ctx.deepseekAccount` 的辅助函数，因此尽管传输层只发送路由交给它的请求头，它仍依赖两个凭据服务。两个路由插件通过这些函数解析凭据，并在 `resolveAuth` 内部抛出各自的凭据缺失错误。Search 与 Fetch API 提供方用路由包自己的配置解析函数，从路由包的 Loader 条目重新推导每条路由的基础地址和密钥引用，按自己的计费设置排定两种凭据的顺序，并自己组装请求头；Messages 搜索则硬编码账号路由 id，并使用自己的一套顺序。因此两个 Web 包都依赖 `llm-deepseek`、两个路由插件和 Loader，而其他 DeepSeek API 的消费方还得把选择凭据、绑定部署、组装请求头和作废凭据再做一遍。位于所有消费方之下的账号服务拥有退登后的 Agent 取消逻辑，并和它仅仅使用的凭据库一起放在 `credentials/` 组。改变一条路由的鉴权方式要同时触及传输层、两个 Web 提供方及其测试。

## 决策

位于 `packages/account/` 组的 `@deepseek-ai/dsh-deepseek-auth` 提供 `ctx.deepseekAuth`。该包同时承担 DeepSeek 请求鉴权的 Service Definition 和 Service Provider，每个调用 DeepSeek API 的插件都是 Consumer。消费方描述一次请求：它的 API 接受的凭据种类 `accepts`、其设置选择的计费方式 `billing`、会话的模型路由 `route`，以及目的地 `destination`，即所选种类的部署之下的一个路径，或一个绝对 URL。`candidates(request)` 按计费顺序返回各个种类，每个种类都绑定到其凭据发往的端点，且不读取任何凭据。`authorize(request, signal)` 把第一个持有凭据的种类释放为 `DeepSeekAuthorization`：`kind`、`endpoint`、请求 `headers`、供诊断使用的密钥 `reference`，账号登录还带有用于 HTTP 401 的 `reject()` 和在账号退登时中止的 `revoked` 信号。授权不携带裸的凭据值：消费方通过 `apiKeyHeaders` 指定 API 密钥放进哪些请求头，账号登录的请求头由账号服务决定。

计费顺序由该服务拥有。`api-key` 与 `account` 计费只尝试对应的那一种。`auto` 跟随会话：在某个插件为账号登录登记的路由上先尝试账号登录、再尝试 API 密钥；在某个插件为 API 密钥登记的路由上只尝试 API 密钥；在其他路由上或不在会话中时，先尝试 API 密钥、再尝试账号登录。该服务自身不写任何路由 id：每个模型路由插件在登记时传入它注册的提供方路由，`routeKind(route)` 回答在该 id 下登记的种类。记录在 `deepseek-account` 或 `deepseek-official` 上的会话，在对应插件未挂载时按其他路由处理。不在 `accepts` 中的种类永远不会成为候选。

每个种类同一时间只有一个部署。模型路由插件在 `ctx.effect()` 内用 `connect(kind, route, connection)` 登记自己的提供方路由及其设置所指的部署，服务为每个请求调用 `connection`。没有登记时，API 密钥是发往 `https://api.deepseek.com` 的 `DEEPSEEK_API_KEY`，账号登录发往 `DEEPSEEK_BASE_URL` 所指的 origin，默认为官方 API。凭据只释放给其种类的部署 origin 之下且不内嵌凭据的目的地。请求可以在 `connections` 里携带某一种类自己的连接，它取代已登记的或默认的连接：模型路由传入它为一次模型请求捕获的那一代配置，拥有自己端点和密钥的消费方传入这两项。连接无法解析的种类作为未解析条目留在候选中，`authorize()` 在此以 `UNRESOLVED_CONNECTION` 停止，不再尝试后面的种类。

API 密钥通过 `@deepseek-ai/dsh-credentials` 的 `resolveCredentialRef` 和 `credentialRefConfigured` 读取，二者把已挂载的凭据服务视为权威，仅在没有该服务时读取启动环境。`dsh-credentials` 还拥有 `normalizeApiKey`，即 Host 端对“能放进 HTTP 请求头的密钥”的定义：它回答去掉首尾空白后的密钥，或密钥不可用的原因，不生成任何诊断文案。该服务为不可用的密钥写出诊断文案，并将其报告为代码 `INVALID_CREDENTIAL` 的 `DeepSeekAuthError`，`llm-pi-ai` 写出自己的文案并报告为 `LlmError`，`@deepseek-ai/dsh-llm` 既不带凭据接口也不带密钥检查。账号登录就是 `ctx.deepseekAccount.resolveRequestCredential(endpoint)` 释放的凭据；组合中没有账号服务时不存在这种凭据。

`@deepseek-ai/dsh-llm-deepseek` 不读取任何凭据。`DeepSeekAdapterOptions.resolveAuth(connection, endpoint)` 返回请求头、可选的 `revoked` 信号和可选的失败回调，或 `undefined`；`missingCredential(connection, provider)` 命名没有凭据时请求的失败，默认为 `MISSING_CREDENTIAL`。传输层让每次模型请求及其文件操作受 `revoked` 信号约束，并把由此产生的失败交给提供方的失败回调命名。列表缓存以端点和凭据请求头的哈希划分作用域。

路由插件是同时登记自身部署的消费方，二者都要求该服务已挂载。`llm-deepseek-api-key` 在自己的路由 id 下登记其基础地址、`apiKeyEnv` 引用，以及作为密钥诊断所指属主的设置命名空间；它以 `accepts: ['api-key']` 索取放在 `x-api-key` 里的密钥，并把不可用的密钥报告为自己的 `INVALID_CREDENTIAL`。`llm-deepseek-account` 在自己的路由 id 下登记其基础地址，以 `accepts: ['account']` 索取凭据，把 HTTP 401 映射为 `ACCOUNT_TOKEN_INVALID`、配额失败映射为 `ACCOUNT_QUOTA`，没有凭据时以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，并拥有退登策略：在 `deepseek-account/signed-out` 时取消其运行中的 Agent，并向账号服务注册运行中任务报告。退登时在途的请求随其授权的 `revoked` 信号结束，以 `ACCOUNT_SIGN_IN_REQUIRED` 失败；它的失败回调会取消同一批 Agent，因此比插件存活更久的请求仍会以退登原因结束其回合。

`@deepseek-ai/dsh-deepseek-account` 向鉴权服务释放请求凭据。`resolveRequestCredential(url)` 返回 `x-dsh-auth-token` 请求头、`reject()` 和 `revoked` 信号；`reject()` 仅在已存储的授权记录仍一致时删除它并隔离存储失败，`revoked` 由账号服务在每次退登时、`deepseek-account/signed-out` 的监听器返回之后中止。`registerRunningTaskReport(report)` 为 `hasRunningAccountTasks()` 提供答案。账号服务不检查任何 Agent，也不依赖 `dsh-agent`、`dsh-llm` 或鉴权服务。包以不变的名字位于 `packages/account/` 组。

Web 提供方声明各自的 API 接受什么。`web-deepseek-api` 以 `accepts: ['account', 'api-key']`、该能力的计费设置、会话的路由，以及路径 `/v1/tools/search` 或 `/v1/tools/fetch` 索取候选；设置了自己的 `*BaseURL` 或 `*ApiKeyEnv` 的能力以 `accepts: ['api-key']` 和自己的连接索取，因此发往该端点的只有那把密钥。`web-search-deepseek` 把搜索端点作为绝对目的地传入，把它引用的密钥作为自己的连接传入。在已登记的账号路由上的会话里，它以 `auto` 计费索取，因此当搜索端点位于账号部署的 origin 之下时先尝试账号登录；其他搜索都以 `api-key` 计费索取。字面 `apiKey` 是该提供方自己的凭据：有它时提供方只索取账号登录，服务不释放任何凭据时发送字面密钥。`web-deepseek-api` 依据候选来措辞凭据缺失和设置无法解析的失败。两个 Web 消费方都隔离失败的 `reject()` 以保证报告的是 HTTP 拒绝，都让请求受授权的 `revoked` 信号约束，并把被该信号结束的请求报告为带登录指引的 `WEB_PROVIDER_ERROR`，`WEB_ABORTED` 仍只表示调用方取消。两个 Web 包都不依赖 `llm-deepseek`、路由插件、Loader 或账号服务，也都不经 `dsh-llm` 读取凭据：`web-search-deepseek` 不依赖它，`web-deepseek-api` 只从它导入消息文本辅助函数 `extractTextContent`。

## 考虑过的替代方案

**通过模型服务发布每条路由的凭据。** `dsh-llm` 上的 `LlmAdapter.providerCredential(provider)` 回答一条路由的凭据种类、基础地址和面向某个端点的授权，消费方读取 `ctx.llm.providerCredential('deepseek-official')` 和 `providerCredential('deepseek-account')`。按模型路由查询意味着每个消费方都要自己按计费排定两种凭据的顺序、自己用裸值组装请求头，并在路由未挂载时自己回退。模型协议之外的 API，例如 `/v1/tools/` 下的语音和文档 API，既没有可以询问的路由，也没有地方声明它接受哪些种类。模型服务还要带上一个凭据接口，而它只有 DeepSeek 适配器一个发布方和两个 Web 消费方。

**在上述发布之上用公共库代替服务。** 模型路由与其他消费方通过同一个操作鉴权，而读取路由所发布内容的库无法反过来为路由本身服务。

**通过 `dsh-llm` 检查密钥、在服务里保留一份副本，或由每个消费方传入校验函数。** 所有 DeepSeek 消费方共用的服务不能依赖模型服务，后者只是其中一类消费方的依赖。Host 端的第二份规则只能靠注释与第一份以及浏览器端的那份保持一致。校验函数参数会让每个接受密钥的消费方都传一个，两个 Web 包也要为此继续依赖 `dsh-llm`。检查放在读取密钥的那一层 `dsh-credentials`，每个调用方依据检查返回的原因写出自己的失败。

**把不可用密钥的诊断文案放在 `dsh-credentials`。** 那里的一个函数能让该服务和 `llm-pi-ai` 使用同样的措辞。但文案要告诉用户在 Models 页面设置该引用，存储凭据的包就会写出其消费方的页面。两个调用方各自写出文案，凭据存储不写任何消费方的名字。

**让 `dsh-llm` 从 `dsh-credentials` 导入密钥检查。** 模型服务里没有任何代码读取密钥。该检查在其中唯一的调用方是 `llm-pi-ai`，而它已经依赖 `dsh-credentials`，因此模型服务不导出密钥检查，也不新增依赖。

**在 `deepseek-account` 旁边设一个 `deepseek-api-key` 包。** `deepseek-account` 是账号这项产品功能：浏览器登录、已存储的授权、资料、余额、通知和 Platform 会话，释放请求凭据只占其中一小部分。API 密钥没有这样的功能。它是通用凭据库里一个有名字的字符串，它的 DeepSeek 专属逻辑就是服务内部的密钥来源。等到出现 DeepSeek 专属的密钥行为，例如按密钥查余额、向服务端校验或多把密钥，才值得拆出一个包。

**合并两个模型路由插件，或合并它们的路由 id。** 它们是两个模型提供方，设置和目录来源不同，还各有 `ACCOUNT_*` 失败映射和针对运行中任务的退登策略。路由 id 是一段会话如何计费的持久记录：会话日志携带它，退登取消和 `auto` 计费读取它。

**在服务里放一张含两个 DeepSeek 路由 id 的固定表。** 无论挂载了哪些插件，`routeKind()` 都会为 `deepseek-account` 和 `deepseek-official` 作答，记录在账号路由上的会话在账号路由插件未挂载时只尝试 API 密钥。这张表会把两个消费方的路由 id 写进它们所依赖的服务。每个路由插件在登记时传入自己的 id，插件未挂载的路由 id 按其他路由处理。

**让路由插件在没有该服务时也能工作。** 把服务做成可选依赖可以让手工挂载路由的组合和测试保持不变，但每条路由都要保留一条绕过该服务的取凭据路径。

**让所有消费方使用同一套计费顺序。** Messages 搜索在账号会话之外从不尝试账号登录。让它采用通用顺序会改变现有会话发送的凭据，因此这条规则保留。

**在授权中加入凭据指纹。** 消费方只负责发送请求，因此只需要请求头；按凭据划分缓存作用域是适配器自己的事，列表缓存通过哈希它发送的请求头即可满足。

**用 `credentials-env` 提供方代替引用函数。** 读取环境的提供方会改变每个消费方眼中哪个组合具有权威性；引用函数把启动环境后备保留在需要它的消费方本地，使这样的提供方仍是独立的选项。

**没有登记账号路由时，账号登录使用账号服务的推理 origin。** 让该默认值经由 `DEEPSEEK_BASE_URL` 可保持无密钥计费快照和所有已记录部署不变；账号服务仍拒绝除自身 origin 以外的一切来源。

**把账号包并入 `identity/`。** 该组定义匿名、不识别用户的 id；已登录账号与之相反，因此单独成组。

**让路由插件的退登监听保留到其任务结束。** 这样卸载路由要等待运行中的回合：停用插件会被阻塞，其他设置写入也排在这次重载之后，直到回合结束。

**路由卸载时取消其任务。** 配置重载或插件更新会停掉与退登无关的回合。

**把退登策略放回账号服务。** 账号服务将重新检查 Agent 并认识路由 id，而这正是本决策去掉的依赖。

**插件卸载后仍保留路由的监听或报告注册。** 比注册它的插件存活更久的注册违反“注册是其所有者的 effect”这一规则，并让已卸载插件的代码在任务运行期间留在其他作用域里。

## 后果

其他 DeepSeek API 的消费方只声明该 API 接受的种类；它不读取凭据、不组装请求头，也不保留回退逻辑。某个 API 新增一种凭据时，它的消费方扩充 `accepts`。新增凭据种类意味着在服务里加一个来源，并为 `DeepSeekAuthKind` 加一个成员。传输层、模型服务、Web 提供方和账号服务在凭据上互不依赖，`hasRunningAccountTasks()` 依赖注册的报告而非账号服务可见的 Agent。`llm-deepseek` 的凭据辅助函数和路由插件的配置导出不复存在；[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.3/deepseek-request-auth/guide.zh.md)列出了替代方案。

凡是挂载 DeepSeek 模型路由或 DeepSeek Web 提供方的组合都要挂载该服务；没有它时这些插件一直等待，不注册任何东西。`base` 和 `sdk-minimal` 两个组合包带有它的条目，SDK 服务端在组合里没有它时随后备路由一起挂载它。每个种类一个部署意味着对同一种类第二次 `connect()` 会抛出 `DUPLICATE_CONNECTION`。`auto` 计费只在注册某条路由的插件已登记时才认它：记录在 `deepseek-account` 或 `deepseek-official` 上而对应插件未挂载的会话，以及经由其他提供方插件访问的 DeepSeek 模型，都按其他路由处理，因此它们的 Search 与 Fetch 操作发送 API 密钥，没有密钥时发送账号登录。路由的配置失败以未解析候选的形式到达消费方：Search 与 Fetch API 将其报告为 `WEB_PROVIDER_MISCONFIGURED`，Messages 搜索报告为 `WEB_PROVIDER_ERROR`，二者都不再尝试后面的凭据。不可用的密钥在 Web 工具的结果里以错误名 `DeepSeekAuthError` 出现。

退登会结束携带账号 token 的在途模型、Files、Search 与 Fetch 请求，包括不属于任何 Agent 回合的请求，例如回合之外的模型请求或按账号计费的 Web 搜索；账号列表请求仍只受自身期限约束。该信号是对[账号退登决策](2026-09-17-account-provider-signout.zh.md)中 Agent 取消链路的补充；那份决策以重复该链路为由否决了登录级信号，而该链路只能经由已挂载的监听和运行中的 Agent 回合到达请求。账号路由被停用期间，它此前启动且仍在运行的任务不会报告给退登确认，退登也只能通过在途的模型请求结束它。已被替换的账号服务释放的凭据不会被替换后服务的退登撤回；路由插件的监听仍会取消 Agent 回合。
