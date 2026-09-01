---
description: "ctx.web 的 Exa 搜索提供方：部署方如何挂载厂商原生 web 搜索，获得可移植 snippet 与发布日期。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-exa`，harness 可以通过 Exa 搜索 web，获得带可移植 snippet 与发布日期的厂商原生结果。当部署持有 Exa API 密钥、并希望使用 Exa 的关键词或神经搜索时选择它。Exa 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。没有非空白高亮的来源会被丢弃，因此一次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `exa` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: exa` 固定。

### 何时选择

当部署持有 Exa API 密钥、并希望使用 Exa 的关键词或神经搜索、获得带每结果高亮 snippet 与发布日期时选择此后端。密钥为空或端点基址无法解析时，提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

加载 web 服务与本提供方；API 密钥回退到启动环境中的 `$EXA_API_KEY`，其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKey: !!js process.env.EXA_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Exa API 密钥；为空或缺失时提供方不可用 |
| `baseURL` | `https://api.exa.ai` | 端点基址；追加 `/search`。无法解析时提供方不可用 |
| `searchType` | `auto` | 以 Exa `type` 发送的检索模式：`auto`、`keyword` 或 `neural` |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；必须是正整数 |
| `highlightsPerResult` | `1` | 每个结果请求的 highlight 句子数（Exa `highlightsPerUrl`）；必须是正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 Exa 结果映射为 `WebSearchSource`：`url`、`title`、以首个非空白高亮作为 `snippet`、`publishedDate` 作为 `publishedAt`；没有高亮的来源缺少可移植的 snippet，会被丢弃。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为成本与延迟优化发送给 Exa——最终上限由服务强制执行：截断并标记。Exa 不返回生成答案，因此结果不携带 `content`。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方按 code 路由；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Exa API 之上的薄适配器，遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源只有在真实高亮存在时才获得 `snippet`；用其他字段捏造会让 seam 说谎，因此没有 snippet 的结果被整个丢弃。
- **不虚构答案。** Exa 不返回生成答案，因此省略 `content`，而不是编造模型可能信任的提供方文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ExaSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Exa 协议类型：`ExaSearchResponse`、`ExaResult`、`ExaError` |
| — | 不发布运行时不变式伴生入口；约定在服务处强制执行。 |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 把查询、检索模式、高亮请求与可选结果数 POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射，没有 snippet 的条目被丢弃，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxResults` 限制的 URL、标题、首条高亮与发布日期，或将确切的错误消息 `Exa search aborted`、`Exa search request failed: <error>` 和 `Exa returned an unprocessable response body: <error>` 保留在消费方的错误包装层内。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **没有非空白高亮的来源会被整个丢弃**——没有可映射的可移植 snippet，因此返回来源可能少于请求数量。
- **只公开 `searchType`／`numResults`／`highlightsPerResult`**——Exa 的其他控制项（livecrawl、category、域名／日期过滤条件、全文内容）等待提供方无关的服务字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Exa 控制面

Exa 的 livecrawl、category、域名与日期过滤条件以及全文内容仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>
