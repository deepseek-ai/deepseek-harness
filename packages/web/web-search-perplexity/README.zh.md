---
description: "ctx.web 的 Perplexity 搜索提供方：部署方如何挂载 OpenAI 兼容的 Perplexity 搜索，获得生成答案与引用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-perplexity

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-perplexity`，harness 可以通过 Perplexity 搜索 web，一次调用同时获得模型生成的答案与可引用来源。当部署持有 Perplexity API 密钥、并希望获得生成答案时选择它。Perplexity 没有结果数量控制，因此返回的来源会在事后被截断到请求的上限。Perplexity 省略结构化结果元数据时，来源回退为只含 URL 的引用。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `perplexity` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: perplexity` 固定。

### 何时选择

当部署持有 Perplexity API 密钥、并希望一次搜索同时获得模型生成的答案与可引用来源时选择此后端。密钥为空或端点基址无法解析时，提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

加载 web 服务与本提供方；API 密钥回退到启动环境中的 `$PERPLEXITY_API_KEY`，其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-perplexity'
  config:
    apiKey: !!js process.env.PERPLEXITY_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$PERPLEXITY_API_KEY` | Perplexity API 密钥；为空或缺失时提供方不可用 |
| `baseURL` | `https://api.perplexity.ai` | 端点基址；追加 `/chat/completions`。无法解析时提供方不可用 |
| `model` | `sonar` | 搜索模型名称 |
| `maxTokens` | `1024` | 生成答案 token 上限（`max_tokens`）；必须是正整数 |
| `searchRecency` | （未设置） | 以 `search_recency_filter` 发送的新近程度窗口：`day`、`week`、`month` 或 `year`。未设置时不发送过滤条件 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-perplexity)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

`content` 携带 Perplexity 的生成答案。`sources[]` 优先使用结构化 `search_results[]`（`url`、`title`、`snippet`、`publishedAt` 取自 `date`），仅当 `search_results` 缺失时才回退到只含 URL 的 `citations[]` 数组——这正是服务上 `title`／`snippet`／`publishedAt` 为可选字段的原因。Perplexity 不公开结果数量控制，因此服务通过截断并标记来强制执行 `maxResults`。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方按 code 路由；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Perplexity chat-completions 端点之上的薄适配器，遵循两条刻意的规则：

- **生成答案作为 `content` 受到信任。** 与其他搜索后端不同，Perplexity 返回模型生成的答案，本提供方将其作为规范化 `content` 字段透传。
- **结构化来源优先；只含 URL 的引用是回退。** `search_results[]` 携带可移植字段；`citations[]` 只携带 URL，服务词汇把这些字段设为可选，正是为了这种情况。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `PerplexitySearchProvider`：请求分发、中止分类、答案与来源映射 |
| [`src/types.ts`](src/types.ts) | chat-completions 响应的 Perplexity 协议类型 |
| — | 不发布运行时不变式伴生入口；约定在服务处强制执行。 |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 把查询连同模型、token 上限与可选新近程度过滤条件 POST 到 `{baseURL}/chat/completions`。响应的 `content` 变为 `content`；存在 `search_results[]` 时它变为 `sources[]`，否则每个 `citations[]` 条目变为只含 URL 的来源；服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-perplexity)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助 Perplexity 请求

#### 模型看到的内容

独立的 Perplexity 模型通过 chat-completions 端点将 `<query>` 原样作为唯一用户消息接收。该请求不属于会话模型上下文。

#### Token 影响

每次搜索都会产生独立的提供方 token；`maxTokens` 限制生成答案。

#### KV Cache 影响

与会话请求缓存相互独立。同一模型路由下的相同查询可能复用提供方缓存；查询或路由改变会建立不同前缀。

### 间接的会话工具结果

#### 模型看到的内容

通过 `dsh-tool-web`，会话模型会看到生成答案及结构化结果元数据，或只含 URL 的引用。该提供方确切的错误消息为 `Perplexity search aborted`、`Perplexity search request failed: <error>` 和 `Perplexity returned an unprocessable response body: <error>`；HTTP 失败保留提供方消息。错误包装层属于消费方。

#### Token 影响

注册不会直接产生会话 token。答案与来源 token 取决于数据，来源数量受服务限制；保留的结果或错误会重复发送，直到发生压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **引用回退来源只含 URL**——Perplexity 省略结构化 `search_results[]` 时，来源不含 `title`／`snippet`／`publishedAt`，因此工具只渲染纯主机名标签。
- **超量返回的来源仍会增加 token 消耗与延迟**——协议没有结果数量控制，`maxResults` 只能由服务在事后截断。
- **只公开 `model`／`maxTokens`／`searchRecency`**——Perplexity 的其他搜索控制项（域名过滤条件、`web_search_options` 上下文大小、图片）等待提供方无关的服务字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Perplexity 控制面

Perplexity 的域名过滤条件、`web_search_options` 上下文大小与图片支持仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>
