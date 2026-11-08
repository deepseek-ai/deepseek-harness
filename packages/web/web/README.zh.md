---
description: "web 访问服务（ctx.web）：部署方与插件作者如何通过可互换的提供方搜索 web 与抓取 URL，以及统一的选择策略与错误词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web

[English](README.md) | 中文

## 概述

使用 `dsh-web` 搜索 web 或抓取 URL，而无需让调用方依赖特定厂商。它为每项操作选择可用后端，并为调用方提供一致的取消、错误和结果上限。在调用 `ctx.web.search()` 或 `ctx.web.fetch()` 的插件或工具中选择它；已交付的 `dsh-tool-web` 工具会为你加载它。搜索或抓取需要已配置且可用的提供方，因为本包自身不发起网络请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要 web 访问的组合会加载 `dsh-web` 服务并挂载至少一个后端——搜索提供方和／或抓取提供方——插件或工具作者随后直接调用 `ctx.web.search()` 与 `ctx.web.fetch()`。服务会为每次调用解析后端，因此除非调用方配置了提供方 id，否则它们看不到提供方 id。

### 何时选择

当插件或工具必须搜索或抓取、又不希望硬编码厂商时选择本服务；只使用已交付的 `web_search`／`web_fetch` 工具的组合会通过 `dsh-tool-web` 自动加载本服务。当组合从不访问 web 时，你不需要它。服务本身不增加任何网络访问能力：没有至少一个可用提供方时，每次调用都会以结构化 `WebError` 失败。

### 最小配置

加载服务并让唯一挂载的后端自动选择，或用 `searchProvider`／`fetchProvider` 固定提供方 id。环境变量 `$DSH_WEB_SEARCH_PROVIDER` 与 `$DSH_WEB_FETCH_PROVIDER` 提供相同字段，不是另一条优先级链。下面两个后端都注册了抓取提供方，因此示例固定 `fetchProvider: http`。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: http
- name: '@deepseek-ai/dsh-web-deepseek-api'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `searchProvider` | （未设置） | 固定的搜索提供方 id；未设置时仅在恰好一个可用时自动选择 |
| `fetchProvider` | （未设置） | 固定的抓取提供方 id；未设置时仅在恰好一个可用时自动选择 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索与抓取

`search()` 执行一次查询，返回可选的提供方答案与可引用的来源列表；服务强制执行 `request.maxResults`：截断 `sources[]` 并设置 `truncated`。`fetch()` 获取一个 URL，返回其最终 URL、状态码、解码后的正文与截断标志；非 2xx 响应是结果，不是错误。

```text
// Search the web; sources[] is capped to maxResults:
const result = await ctx.web.search({ query: 'deepseek harness', maxResults: 8 })

// Fetch one URL; a non-2xx response is a result, not an error:
const page = await ctx.web.fetch({ url: 'https://example.com' })
```

两个调用都接受可选的 `AbortSignal`，用于把取消转发给提供方。规范化的请求与结果形状是调用方赖以构建的约定；[web 子系统](../../../docs/subsystems/web.zh.md) 参考中的词汇章节对其有穷尽式描述。

### 提供方选择

每次调用都在执行时解析提供方，注册或加载顺序从不影响结果。已配置的提供方 id 在已注册且可用时优先；没有配置 id 时，服务运行唯一可用的提供方，或在情况不明时明确失败：

| 情况 | 结果 |
|---|---|
| 已配置 id 已注册且可用 | 运行该提供方 |
| 已配置 id 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
| 已配置 id 已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 无 id，恰好一个已注册的可用提供方 | 运行它 |
| 无 id，没有可用提供方 | `WEB_PROVIDER_UNAVAILABLE` |
| 无 id，多个可用提供方 | `WEB_PROVIDER_AMBIGUOUS` |

随附的 `deepseek-official` 与 `deepseek-search-api` 搜索 id 分别选择旧版 Messages 搜索与直接 Search API。

提供方的可用性是一项廉价的局部检查——例如其 API 密钥是否存在——并且从不发起网络调用，因此选择保持快速且确定。

<a id="listing-providers"></a>
### 列出提供方

`listProviders()` 以 `{ id, title?, description? }` 条目返回所有已注册的搜索与抓取提供方，每个列表按注册顺序排列；不可用的提供方同样列出，因为选择器展示的是可以固定的提供方。`title` 是提供方可选的显示名，缺省时选择器显示 `id`。`description` 是可选的 `LocalizedText`（来自 `dsh-package-manifest`），可以是纯字符串，也可以是以小写语言 id 为键、必须含 `en` 的翻译表，说明该提供方适合什么、有什么代价或做不到什么；选择器在选中该提供方时把它显示在下方，缺省时不显示。每次注册与每次注销都会在注册表变更后发出无载荷的 `web/providers-changed` 事件，观察者失败不能否决该变更。客户端通过 `web` Remote 命名空间调用同一方法，即 `ctx.remote.web.listProviders()`；它返回 Remote 结果，只有 `ok` 为 true 时 `value` 才带有列表。客户端在转发的 `web/providers-changed` 事件上刷新；[网页搜索与获取设置页](../../client/ui-settings-web-search/README.zh.md)以此填充搜索与获取下拉框。插件（包括在创造模式中编写的插件）注册带 `title` 的提供方后，即以该名称出现在对应下拉框中，选中时显示其 `description`，选中它会把 `searchProvider` 或 `fetchProvider` 固定为它的 `id`。

```text
// Remote: web/listProviders; Host event: web/providers-changed
const response = await ctx.remote.web.listProviders()
if (response.ok) {
  const { search, fetch } = response.value
} // else: response.error is a structured RemoteError; keep any previous list and report it
ctx.remote.$on('web/providers-changed', () => { /* re-read the lists */ })
```

<a id="adding-a-provider"></a>
#### 添加其他提供方

内置组合之外的搜索或抓取后端是一个插件包，它以唯一的 `id` 和可选的 `title` 调用 `ctx.web.registerSearchProvider()` 或 `ctx.web.registerFetchProvider()`。要在某个 profile 中启用它，先用 `dsh plugin --profile <name> add <package>` 安装该包（[安装规则](../../../docs/user/develop/basic/publish.zh.md)），再把它的行加入该 profile 的用户 patch 层 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，然后重启 DSH。该文件是由 patch 条目组成的顶层 YAML 数组；请追加下面的 `insert` 条目，或用它替换单独的 `[]`。示例挂载一个假想的 `@example/dsh-web-search-acme`；请换成提供方真实的包名，并添加其 README 说明的 `config`。

```yaml
- insert:
    - id: web-search-acme
      name: '@example/dsh-web-search-acme'
```

`dsh --profile <name> --dump-config` 会在该 patch 文件的层下打印这一行。重启后，该提供方以其 `title`（没有 `title` 时以其 `id`）出现在[设置页](../../client/ui-settings-web-search/README.zh.md)的**网页搜索提供方**或**网页获取提供方**下拉框中，设置页无需任何修改。选中它会把 `searchProvider` 或 `fetchProvider` 固定为它的 `id`。如果之后在该提供方被选中时删除了这一行，下拉框会把已保存的 id 显示为 **（未加载）**，每次调用都会以 `WEB_PROVIDER_CONFIGURED_MISSING` 失败，直到选择其他提供方。

<a id="search-readiness"></a>
### 搜索与抓取就绪

`searchReady(llmProvider?)` 与 `fetchReady(llmProvider?)` 询问 `search()` 或 `fetch()` 会选中的提供方：为该对话路由上的模型请求发起的操作是否有可发送的凭据；[`dsh-tool-web`](../tool-web/README.zh.md#search-readiness) 据此决定每个模型步骤是否准入 `web_search` 与 `web_fetch`。提供方通过可选的 `ready(llmProvider)` 回答，它是只检查配置的判断，禁止发起网络调用；未实现它的提供方视为就绪。选择失败时就绪方法回答 true，因为对应操作会把该失败报告为结构化 `WebError`。就绪判断从不改变选中哪个提供方。

```text
// false only when the selected provider cannot authenticate this route's operations:
const searchOffered = await ctx.web.searchReady('deepseek-official')
const fetchOffered = await ctx.web.fetchReady('deepseek-official')
```

### 失败与恢复

失败抛出 `WebError`，携带稳定、可按机器路由的 code；消息补充细节，例如缺失的提供方 id 或歧义候选集合。调用方按 code 路由并决定如何降级。要改变一次调用使用的后端，请重新配置固定的 id、挂载或卸载提供方，或修正提供方配置使其可用性检查通过。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在一个刻意的分离之上：

- **一个 seam，两个独立操作。** 搜索与抓取没有共享请求 schema 或业务逻辑，但它们共用一个服务，使提供方选择、取消、错误与产品配置只有一个归属方。并行的 `Search`／`Fetch` 方法对是有意为之。
- **选择绝不依赖顺序。** 能力要么固定提供方 id，要么在恰好注册一个可用提供方时自动选择；`search()`／`fetch()` 在执行时解析提供方。
- **服务拥有结果上限。** `maxResults` 由 seam 在提供方返回后强制执行，因此超量返回的提供方绝不可能泄漏超出调用方要求的来源。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`WebRuntime` 服务、两个提供方注册表、`web/listProviders` Remote 方法与 `web/providers-changed` 事件、执行时选择与按路由的就绪判断 |
| [`src/types.ts`](src/types.ts) | 词汇：请求／结果类型、提供方列表条目、`web/providers-changed` 事件声明、封闭的 `WebFetchBody` 联合与 `WebError` 分类体系 |

### 数据模型

请求与结果类型定义了调用方赖以构建的规范化词汇——`Search` 请求／结果对与 `Fetch` 请求／结果对各一组——穷尽式字段与 JSDoc 见 [`src/types.ts`](src/types.ts) 与 [web 子系统](../../../docs/subsystems/web.zh.md) 参考。两个刻意的选择塑造了它们：`WebFetchBody` 是这里拥有的封闭联合（`html` | `text`），因此新增类型会破坏编译，直到每个消费方都处理它；`WebError` 继承 `HarnessError`，携带开放的字符串 `code`，因此消费方必须容忍提供方专有的取值。来源字段保持可选，因为并非每个提供方都返回全部字段。

### 选择流程

执行时，服务先按配置 id、再按唯一可用提供方解析提供方，没有明确赢家时抛出对应的 `WebError`。搜索结果随后经过 `capSources`：把 `sources[]` 截断到 `maxResults` 并标记 `truncated`。`searchReady()` 与 `fetchReady()` 解析与对应操作相同的提供方，解析抛错时回答 true，否则返回该提供方 `ready()` 的回答，提供方没有 `ready()` 时回答 true。注册基于 effect：提供方随调用 fiber 注册，fiber 释放时注销；同一能力类型下重复的 id 会在注册时被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入已交付后端、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索／抓取请求与结果、提供方可用性与错误码。
- [web 包映射](../README.zh.md)——五包家族与各角色。
- [dsh-tool-web](../tool-web/README.zh.md)——构建于本服务之上的面向模型 `web_search` 与 `web_fetch` 工具。
- [dsh-web-fetch-http](../web-fetch-http/README.zh.md)——已交付的匿名 HTTP(S) 抓取后端。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。
- [搜索就绪决策](../../../.agents/notes/implemented/architecture/2026-09-27-web-search-offered-by-provider-readiness.zh.md)——seam 为何为 `dsh-tool-web` 按路由回答搜索与抓取就绪。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把 seam 规范化的搜索结果与抓取正文渲染给模型，并且不让 `searchReady()` 或 `fetchReady()` 回答 false 的模型步骤准入 `web_search` 或 `web_fetch`，而本服务不贡献任何提示词或 schema。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本服务单独使用时在哪些方面不完整。它们是当前包约束。

- **没有可用性观测**：`listProviders()` 与 `web/providers-changed` 只报告哪些提供方已注册，不报告它们是否可用；没有能力状态查询，`searchReady()` 与 `fetchReady()` 只报告选中提供方的凭据就绪状态，选择失败时回答 true。可用性只能通过执行搜索或抓取并按抛出的 code 路由来观测，无提供方失败是通用的 `WEB_PROVIDER_UNAVAILABLE`，不枚举逐提供方原因（见 [Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.md)）。
- **搜索请求只携带 `query` 与 `maxResults`**：提供方无关的控制项（新近程度、域名过滤条件、区域提示、搜索深度）暂缓至后端都能诚实支持时（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **`WebFetchBody` 没有 `pdf` 分支**：可提取文本的 PDF 支持属于明确的延期工作；封闭联合会使新增该分支成为跨 web 包、由编译强制执行的变更。
- **提供方支持的页面提取不属于 `fetch()` 范围**：Firecrawl/Tavily 风格的 `web_extract` 能力延期，而不会扩展抓取操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：观测提供方状态

注册情况可通过 `listProviders()` 与 `web/providers-changed` 观测，但没有能力状态查询；消费方只能通过执行调用并按抛出的 code 路由来观测可用性。如果消费方需要逐提供方原因，恢复一个小的观测接口是可行的，但已归档的简化笔记记录了为何放弃此前的那个接口。

</details>
