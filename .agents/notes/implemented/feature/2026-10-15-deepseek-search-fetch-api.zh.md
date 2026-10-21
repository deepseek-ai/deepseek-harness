# Agent Note: 直接接入 DeepSeek Search 与 Fetch API

Status: implemented

[English](2026-10-15-deepseek-search-fetch-api.md) | 中文

## 问题

通过 Messages 获取 DeepSeek 网页搜索结果时，每个查询都需要一次辅助模型请求。Harness 提取来源与引用摘录，却丢弃生成的回答。独立 Search 和 Fetch API 直接提供结构化来源与 Markdown，使检索无需由 Harness 发起这次辅助生成。接入这些 API 需要明确选择两种操作的提供方、独立配置部署地址，并把 Fetch 结果映射到现有抓取结果。

## 决策

2026-10-16 核对的 [DeepSeek Search 与 Fetch 指南](https://api-docs.deepseek.com/zh-cn/guides/search)定义上游 API。[web-deepseek-api 插件](../../../../packages/web/web-deepseek-api/README.zh.md)通过现有 `web_search` 和 `web_fetch` 工具接入它，[web-search-deepseek](../../../../packages/web/web-search-deepseek/README.zh.md) 保留 Messages 搜索。[Web 能力决策](../architecture/2026-06-24-web-capability-seam.zh.md)继续负责提供方选择、工具职责和抓取结果字段。

### 协议选择与部署

两个 API 注册为 `deepseek-search-api` 和 `deepseek-fetch-api`；Messages 搜索保留 `deepseek-official`。网页搜索页上的设置 **Use the new Web Search API**（**启用新版 Web 搜索 API**）同时写入 `web.searchProvider` 和 `web.fetchProvider`：开启时选择两个 API，关闭时恢复内置选择，即 Messages 搜索与本地 HTTP 抓取。开关默认关闭，保存后生效，因为 Web 服务在每次操作时读取两项选择。在 Search API 正式发布公告之前，Messages 仍是默认值，已有用户无需配置即可继续使用搜索。每次操作解析一份设置快照，包含端点和凭据。两个 API 读取同一份凭据和同一个 API 基础地址，因为指南从同一基础地址提供它们，开关也同时选择它们。

两种协议分别保存 API 基础地址。Messages 保留 `https://api.deepseek.com/anthropic/v1`，追加 `/messages`。直接检索使用 `web-deepseek-api.baseURL`，默认值为指南中的公网地址 `https://api.deepseek.com/v1/tools`，追加 `/search` 或 `/fetch`；已验证的开发地址为 `http://api-dev.deepseek.com:8031/api/v1/tools`。两者前缀不同，程序不会根据主机名推断，其他部署需填写完整基础地址。开关本身已是显式启用，因此以文档中的公网部署作为默认值。基础地址为空白或无法解析时，两个提供方都不可用。

指南规定使用 API 密钥进行 Bearer 鉴权，请求只发送文档规定的鉴权与 JSON 内容类型请求头。DeepSeek 账号路由上的会话改为发送其账号 token，与 Messages 搜索一致；2026-10-16 公网 Search 与 Fetch 路由已接受该 token，因此只登录账号的用户也可以启用直接检索。同日检查的一个 Anthropic 兼容网关提供 Messages 网页搜索，但没有 `/v1/tools` 路由；此类部署继续使用 Messages 搜索。

### 搜索结果与模型输入

直接 Search 发送 `query`、`count`、`need_content: false` 和 `ori_question`。`count` 为 1 至 50 的配置值，默认采用服务的 10；请求的结果上限更小时以后者为准，工具总会发送其上限，默认为 8。`ori_question` 是发起会话中最近一条用户提示的文本，空白折叠后截取至 API 的 128 个字符上限。API 拒绝空白或更长的值，因此没有此类提示的搜索不发送该字段，`sendOriginalQuestion: false` 可将其关闭。2026-10-16 的探测中，不同取值未改变结果顺序、评分或摘要。查询原样传递，包括文档中的站点、语言、日期、排除和精确短语操作符。服务端执行查询长度为 1–128 个 Unicode 字符的约束。空 `results` 表示成功。

提供方保留服务端顺序，将 URL、标题、`snippet`、`summary` 和可为 null 的 `date` 映射为共享来源。按照指南，工具把每个来源的 `summary` 提供给模型，短的 `snippet` 留给搜索卡片及其回放元数据。指南中的典型摘要长度不是最大值：2026-10-16 实测返回的摘要为 1,000–2,300 个字符。因此 `dsh-tool-web` 合并摘要中的空白，并将每条摘要限制在 `searchSummaryMaxChars` 以内，默认 800 个字符，即指南典型范围的上限；一次调用的摘要总长不超过来源上限乘以该上限。摘要随工具输出值和渲染文本一起进入 Session 记录。提供方不使用完整 `content`、`site_name`、`site_icon`、`rerank_score` 或 `authority`，也不发送 `localization`。这些是当前接入的限制，并非 API 缺少这些能力。

直接检索不产生辅助模型请求事件，因为 Harness 没有发起该请求。普通工具调用与工具结果事件继续保留查询及模型可见的结果。这不代表搜索服务内部不使用模型。返回文本仍是外部不受信任的数据。

### 抓取元数据与职责

Fetch 发送 URL，返回 Markdown，无需 Harness 额外发起摘要请求。API 既不提供重定向后的最终 URL，也不提供目标 HTTP 状态，而共享结果没有标题字段。提供方保留请求 URL，返回 Markdown 正文，并对成功响应报告 HTTP 200：URL 不可用、被站点策略拦截、目标站点返回错误或无法提取 Markdown 时，Fetch API 会返回 404。2026-10-16 无法解析的主机实际返回 HTTP 500，因此任何非成功状态都视为抓取失败，而不是对目标的具体诊断。共享抓取结果及其消费方保持不变。

HTTP 提供方继续负责自身的 URL 校验和资源限制。选择 DeepSeek 会将页面抓取与目标访问策略交给该服务；Harness 拒绝 API 请求重定向，并保留取消与工具输出限额。因此报告的 HTTP 200 表示服务已获取页面，而不是 Harness 观察到了目标响应。指南中的 Fetch 403 表示抓取器策略拒绝，404 则表示没有可用的页面内容。

### 默认值迁移

将默认值改为 Search API 是发布公告之后的另一项变更。API 密钥和账号 token 都能访问公网路由；位于没有 `/v1/tools` 路由的网关之后的部署，需要在默认值变更前显式设置 `web.searchProvider: deepseek-official`，已保存的 Messages 选择仍使用 Messages。

### 附带的 Messages 修复

保留的 Messages 路径显式发送 `thinking: { type: 'disabled' }`，并在发送前记录同一请求体。这避免了辅助请求在生成回答被丢弃的情况下执行思考；它不实现或控制新的检索 API。`tool_choice` 仍不传递。[持久化确认记录](../../../../docs/persistence-changes/2026-10-13-deepseek-search-thinking.zh.md)负责日志中可选字段的兼容性。

## 考虑过的替代方案

**仅保留 Messages 搜索实现。** 即使调用方只需要来源，这也保留了辅助生成和响应提取。直接 Search 去掉这次 Harness 模型请求，同时保留 Messages 供显式选择。

**立即将 Search API 设为默认值。** 尚未发布公告，部分网关也只提供 Messages；这些用户会失去可用的搜索。

**复用 Messages 地址或推断路由前缀。** 协议与部署前缀不同。分别保存基础地址可保留现有配置，避免把有效请求发往错误路由。

**要求显式填写 Search API 基础地址。** 开启开关已是显式选择，空默认值会迫使每位用户复制文档中的公网地址。其他部署仍可覆盖它。

**把两个 API 放在 Messages 提供方内部，由提供方自己的开关切换。** `web-search-deepseek` 内的开关无法改变抓取路由，因此开启后除非用户另外修改 `web.fetchProvider`，`web_fetch` 仍走 HTTP；它还把两个 API 的生命周期绑在 Messages 搜索上，而默认值迁移后 Messages 搜索可能被移除。独立注册让 Web 服务现有的选择来表达这个开关，每个包都可以单独修改或移除。

**让 Messages 搜索与新 API 共用一套传输层。** 两者都通过同样的 seam，即 `ctx.credentials` 和 `ctx.deepseekAccount` 解析凭据，共享模块只能省下请求派发与失败映射代码。它会让 Messages 包依赖新 API 包、两者必须一起发版，而默认值迁移后 Messages 搜索可能被移除。在此之前，两个包各自保留传输层。

**把 Search 和 Fetch 拆成两个包。** 指南从同一基础地址、以同一份凭据提供两个 API，开关也同时选择它们；拆成两个包会让用户只需编辑一次的设置重复出现。每种操作位于独立模块，任一 API 都可以单独修改。

**在设置页用下拉框列出所有已注册的提供方。** 通用提供方表单从 Config schema 推导编辑控件，还需要在提供方接口上增加宿主侧展示元数据。该页面只需要 DeepSeek 的选择，其他提供方保留各自的设置页。

**让模型以工具参数提供 `ori_question`。** API 将该字段定义为用户的原始问题，而最近一条用户提示已记录了这段文本。工具参数会改变所有搜索提供方共用的面向模型的 schema，并引入改写。

**开启开关时保留 HTTP 抓取。** 该开关用于启用 DeepSeek 新的检索 API，保留 HTTP 抓取会让使用 Fetch API 依赖手动修改 `web.fetchProvider`。开关关闭时，抓取仍选择带有自身访问策略的 HTTP 提供方，配置中也仍可单独选择任一抓取提供方。

**新增提取工具或扩展抓取结果。** API 以 Markdown 获取一个具体网页，符合现有抓取操作。其成功本身即表示已获取页面，Markdown 正文也带有页面标题，因此扩展结果会改动每个抓取消费方，而模型可见的收益很小。

## 影响

直接模式中的检索不再需要辅助模型 token，但结果仍消耗主模型上下文。2026-10-16 通过网关进行的一次 Messages 网页搜索，为一次服务端搜索消耗了 8,154 个输入 token 和 828 个输出 token。指南对 Search 和 Fetch 分别按每 1,000 次成功且有结果的请求收取 5 元；结果条数不影响单次价格。多个查询仍对应多次请求。文档中的 Claude Code 与 Codex 优惠不能作为 Harness 免收费用的依据。除非关闭 `sendOriginalQuestion`，Search API 模式还会随每个查询把用户提示的至多 128 个字符发送给搜索服务。

Search 和 Fetch 各有账号级 5 QPS 限制，独立于模型并发，同一账号的 API 密钥共享额度。Fetch 还有目标域名限制。当前工具可并发发送四个查询，任一查询失败会使整批失败。提供方没有共享限速调度器、自动重试或回退；其他会话或进程也会消耗同一账号的额度。

## 验证与尚未接入的 API 能力

提供方测试覆盖请求映射、空结果、格式错误的响应、独立地址与默认地址、账号 token 鉴权、取消与空白配置。设置测试及[插件配置浏览器场景](../../../../apps/web/tests/plugin-config.e2e.ts)覆盖暂存后保存、默认地址和同时切换两项选择。[网页搜索回放](../../../../apps/web/tests/web-search-round.e2e.ts)与 [Fetch Session 回放](../../../../snapshots/session/deepseek-fetch/snapshot.yml)固定模型可见结果。2026-10-16，[真实提供方测试](../../../../packages/web/web-deepseek-api/tests/web-deepseek-api.e2e.ts)在公网地址通过了 Search 与 Fetch 验证；在内置配置上运行的一轮 headless 对话返回了八个来源并抓取到 Markdown，且没有辅助请求事件。上文的账号 token、网关和状态码观察来自同日的手动探测。

以下能力尚未包含在已实现的接入中：

- 在适用于提供方的工具说明中介绍搜索语法，先定义有界的本地化输入，再进行转发。API 的 `localization` 是 IP 地址，不能用推测的城市或界面语言代替。
- 先保留质量元数据，再定义筛选策略。`rerank_score` 与 `authority` 表示服务端评估，不保证内容真实；固定阈值可能丢弃有用的冷门来源。
- 增加支持取消的调度并明确有限重试的职责。指南建议对 408、429 和 5xx 等待后重试；402 需要先充值，其他 4xx 需要修改请求。本地节流无法跨无关进程执行账号级配额。
