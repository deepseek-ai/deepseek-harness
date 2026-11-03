---
description: "DeepSeek Search 与 Fetch API 提供者、共享的鉴权与传输层、端点配置及标准化结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-deepseek-api

[English](README.md) | 中文

## 概述

通过 DeepSeek Search 与 Fetch API 搜索和抓取网页：每次操作只发起一次直接请求，无需辅助模型请求。插件注册 `deepseek-search-api` 和 `deepseek-fetch-api`；每个能力跟随会话的 DeepSeek 凭据：在 DeepSeek 账号模型提供方上的会话使用 DeepSeek 账号登录，其他情况使用 DeepSeek API 密钥。也可以在 YAML 中为任一能力单独配置基础地址与密钥。Search 返回标题、URL，以及可用的 snippet、summary 与发布时间；Fetch 返回页面 Markdown。面向模型的工具由 `dsh-tool-web` 提供；[旧版 Messages 搜索](../web-search-deepseek/README.zh.md)仍是独立提供方。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将插件与 `dsh-web` 一起挂载，并选择它的提供方。内置配置挂载此插件，为搜索选择它的 Search API（`deepseek-search-api`），为抓取选择本地 HTTP 抓取。在**插件 > 内置插件配置 > 网页搜索与获取**中，在**搜索**下拉框选择 **DeepSeek Search API** 会选中 `deepseek-search-api`，在**获取**下拉框选择 **DeepSeek Fetch API** 会选中 `deepseek-fetch-api`；两个下拉框分别保存，选择其他条目即改用其他提供方。保存的选择从下一次操作开始生效。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    searchBaseURL: https://search.example.test/api/v1/tools
    searchApiKeyEnv: DEEPSEEK_SEARCH_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `count` | `10` | Search API 每次搜索的结果数，为 1 至 50 的整数；请求中更小的 `maxResults` 优先 |
| `searchRequestsPerSecond` | `5` | 本插件实例在任意一秒窗口内最多发送的 Search 请求数，与服务的账号级 5 QPS 限制一致；后续搜索排队等待，等待时间计入调用方的超时 |
| `sendOriginalQuestion` | `true` | 将触发搜索的用户提示截取至 128 个字符，作为 Search API 的 `ori_question` 发送 |
| `searchBaseURL` | 省略 | Search API 基础地址，包含路径前缀；追加 `/search`。只设置此项时，`searchApiKeyEnv` 默认为 `DEEPSEEK_API_KEY`（[鉴权](#authentication)） |
| `searchApiKeyEnv` | 省略 | Search 凭据引用。只设置此项时，`searchBaseURL` 默认为 `https://api.deepseek.com/v1/tools` |
| `fetchBaseURL` | 省略 | Fetch API 基础地址，包含路径前缀；追加 `/fetch`，默认值规则相同 |
| `fetchApiKeyEnv` | 省略 | Fetch 凭据引用，默认值规则相同 |

两个字段都未设置的能力跟随会话，请求所选 DeepSeek 模型路由解析后的 Messages 基础地址的 origin 下的 `/v1/tools/search` 与 `/v1/tools/fetch`，因此官方 `https://api.deepseek.com/anthropic` 或 `DEEPSEEK_BASE_URL` 覆盖值分别得到 `https://api.deepseek.com/v1/tools`，或覆盖值的 origin 加 `/v1/tools`。单独配置的基础地址填写完整的 API 基础地址，包含路径前缀，但不包含操作名；使用其他前缀（例如 `/api/v1/tools`）的部署需要填写其完整基础地址。空字段视为未设置。这些单独配置的字段只能在 YAML 中设置；设置页只选择提供方，不显示这两个提供方的凭据控件。早期设置中保存的 `baseURL`、`apiKeyEnv` 与 `apiKey` 字段可以正常加载，但不再生效。

真实 API 测试要求同时设置 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_SEARCH_API_TEST_BASE_URL`，后者包含 API 路径前缀。

<a id="authentication"></a>
### 鉴权

Search 与 Fetch 每次操作各自从同一份设置快照解析端点和凭据，因此保存的设置、模型提供方变更、登录或存入的密钥从下一次操作开始生效。会话的路由是发起会话最近一次请求上下文的 `provider`；`ready()` 使用正在准备的模型请求的路由。

- **单独配置。** 设置了非空 `*BaseURL` 或 `*ApiKeyEnv` 的能力在任何路由上都只以 `Authorization: Bearer` 把其 `*ApiKeyEnv`（未设置时为 `DEEPSEEK_API_KEY`）下的密钥发往其 `*BaseURL`（未设置时为 `https://api.deepseek.com/v1/tools`），从不发送账号令牌。没有该密钥时，操作失败，诊断信息点名该引用和 `*ApiKeyEnv` 字段。
- **账号会话。** 在 `deepseek-account` 路由上，若模型提供方目录为 `deepseek-account` 列出了入口根部活动且有效的 `@deepseek-ai/dsh-llm-deepseek-account` Loader 条目，操作只发送 `ctx.deepseekAccount` 为该路由 origin 下的请求端点给出的令牌，通过 `x-dsh-auth-token` 发送；2026-10-16 公网 Search 与 Fetch 路由已接受该令牌。没有登录、账号服务或非空令牌，或没有该条目时，改为把下文的 API 密钥发往 API 密钥端点。账号令牌读取失败时操作失败，不再尝试密钥。条目活动但其设置被该路由自身的解析器拒绝时，操作在读取任何凭据前失败。
- **其他会话**，包括 `deepseek-official` 上的会话、其他提供方上的会话以及会话之外的操作，以 `Authorization: Bearer` 把目录为 `deepseek-official` 列出的活动 `@deepseek-ai/dsh-llm-deepseek-api-key` 条目的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）下的密钥发往该路由的 origin，并按该路由的方式解析其选项。没有该条目或条目未激活时，把 `DEEPSEEK_API_KEY` 发往 `https://api.deepseek.com/v1/tools`。条目活动但其设置被该路由自身的解析器拒绝时，每个需要发送该密钥的操作都在读取密钥前失败，绝不改用官方端点或 `DEEPSEEK_API_KEY`。没有密钥时，操作失败，诊断信息点名模型页面、该引用和账号登录。

引用使用[共享 DeepSeek 凭据函数](../../llm/llm-deepseek/README.zh.md#account-credentials)：`ctx.credentials` 具有权威性，仅在该服务缺席时读取启动环境。路由密钥与单独配置的密钥均接受与模型请求相同的首尾空白规范化和格式校验；格式错误在发送请求前失败。

每个提供者的 `ready()` 按操作的解析顺序回答其在该路由上的下一次操作是否有凭据：在账号路由上先看非空账号令牌，再看 `ctx.credentials.describe` 报告已配置的密钥（没有该服务时，启动环境必须包含它）。账号令牌或凭据存储读取失败，或所需路由条目的设置无法解析时，回答 false。这两个提供者被选中时，[`dsh-tool-web`](../tool-web/README.zh.md#search-readiness) 会从它们回答 false 的每个请求中撤下 `web_search` 与 `web_fetch` 及其提示词指引。只检查是否存在：错误的密钥仍算就绪，并使每次调用失败。

### 结果与失败

Search API 接收 `query`、`count`（配置的结果数，或请求中更小的 `maxResults`）、`need_content: false`，以及在 `sendOriginalQuestion` 未关闭时的 `ori_question`：发起会话中最近一条用户提示的文本，空白折叠后截取至 128 个字符。在会话之外或没有此类提示的搜索不发送该字段。提供者将 `results[].snippet` 映射为展示用摘录，将 `results[].summary` 映射为面向模型的摘录，并将可为 null 的 `date` 映射为可选的 `publishedAt`；`dsh-tool-web` 限制每条摘要的长度。空结果数组表示成功。Fetch 发送 `url`，以文本正文返回原始 Markdown，并报告 HTTP 状态 200，因为目标没有可用内容时 API 会返回错误状态。返回 URL 为请求 URL：API 不报告重定向后的最终 URL。

单独配置的基础地址无法解析时，该能力的提供者不可用；`count` 不在 1 至 50 之间时，Search 不可用。凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败；所需模型路由的设置无法解析时以 `WEB_PROVIDER_MISCONFIGURED` 失败，并点名解析器的失败原因、模型页面以及该能力的 `*BaseURL` 与 `*ApiKeyEnv`；取消使用 `WEB_ABORTED`；传输、HTTP 和响应格式错误使用 `WEB_PROVIDER_ERROR`。重定向在联系目标前即被拒绝。Fetch API 的非成功状态表示抓取失败，不代表目标页面的状态。账号鉴权的 HTTP 401 响应只作废该请求实际发送的 token，并提供重新登录指引；更新的登录不受影响，凭据删除失败不会替换原 HTTP 错误。API 密钥失败与 HTTP 403 从不作废账号 token；其他请求失败指出端点及其来源：路由端点指导用户在模型页面检查该提供方的基础地址，或设置该能力的 `*BaseURL` 与 `*ApiKeyEnv`；单独配置指导用户修改或删除这两个字段。不会自动重试或回退至其他提供者。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[插件](src/index.ts)在每次操作时读取一次设置，注册两个提供者，并把一个能力的设置快照、会话的路由和活动的模型路由条目转换为其端点和凭据。[Search 提供者](src/search.ts)在返回服务结果前校验响应 JSON；[Fetch 提供者](src/fetch.ts)校验 Markdown 正文。[传输层](src/transport.ts)负责凭据解析、在账号端点与 API 密钥端点之间选择、取消、重定向拒绝和失败指引；记录钩子在发送前运行，抛出异常即阻止发送。Search 与 Fetch API 调用不产生辅助请求事件。[Messages 搜索提供方](../web-search-deepseek/README.zh.md)负责声明和记录自身的 `web/deepseek-search-llm-request` 会话事件。工具调用和结果仍按常规记录到会话。

服务类型见 [Web 子系统](../../../docs/subsystems/web.zh.md)，受限的模型输出见 [tool-web](../tool-web/README.zh.md)。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 会话工具结果

#### 模型看到什么

`web_search` 和 `web_fetch` 工具在外部内容提示下呈现搜索来源或 Markdown。Fetch 结果包含请求 URL 和 HTTP 200。错误保留可操作的凭据或端点指引。Search 将查询连同触发问题直接发送给 Search API。

#### Token 影响

不消耗辅助模型 token。会话结果 token 随返回的 summary、snippet 或 Markdown 增长，并受消费方限制。API 抓取计费独立于模型 token。

#### KV Cache 影响

工具结果追加在已有会话前缀之后。提供者注册不增加模型上下文。

### 会话工具列表（间接）

#### 模型看到什么

这两个提供者被选中时，其中一个未就绪的会话请求既不包含对应工具（`web_search` 或 `web_fetch`）的 schema，也不包含该工具的提示词指引；该效果由 [`dsh-tool-web`](../tool-web/README.zh.md#search-readiness) 负责。

#### Token 影响

撤下时，请求中不再包含该工具的 schema 及其提示词指引。

#### KV Cache 影响

重新提供或移除 Web 工具会按 [`dsh-tool-web`](../tool-web/README.zh.md#search-readiness) 所述改变声明的工具。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 共享搜索请求不暴露 `localization`；提供者不请求搜索全文，也不消费 `site_name`、`site_icon`、`rerank_score` 或 `authority`。2026-10-16 实测返回的 `summary` 长度为 1,000–2,300 个字符，超过消费方的默认上限。
- 2026-10-16 的探测中，不同的 `ori_question` 未改变结果顺序、评分或摘要；由于指南将其列为意图信号，提供者仍会发送。
- 查询和 URL 约束由远端服务执行。2026-10-16 抓取无法解析的目标域名时返回 HTTP 500，而非文档所述的 404，其失败信息与端点失败附带相同的端点指引。Fetch 既不暴露目标状态，也不暴露最终重定向 URL，因此结果报告 HTTP 200 和请求 URL；提供者丢弃 API 返回的页面标题。
- `available()` 无法查询异步凭据存储；`ready()` 可以，因此凭据存储缺少密钥时，模型步骤会撤下这两个工具。直接调用 `ctx.web.search()` 或 `ctx.web.fetch()` 仍可能因凭据缺失失败。
- Search 限速只约束单个插件实例内的发送时间。同一账号下的其他进程和客户端共享账号级 5 QPS 限制，彼此不协调，网络抖动也可能使请求集中到达；HTTP 429 会使该次搜索失败，随后 `dsh-tool-web` 会使整个多查询调用失败。Fetch 不限速，因此并行的 `web_fetch` 调用可能超过 Fetch 限制。
- 路由端点与密钥只认入口根部的 `@deepseek-ai/dsh-llm-deepseek-api-key` 与 `@deepseek-ai/dsh-llm-deepseek-account` Loader 条目；以相同提供方 id 注册的其他包（例如测试回放适配器）视为没有路由，其会话使用 `DEEPSEEK_API_KEY` 与官方基础地址。

<a id="dev-note"></a>
### 开发备注

无。
