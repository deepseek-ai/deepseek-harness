---
description: "ctx.web 的 DeepSeek 搜索提供方：部署方如何通过 Anthropic 兼容 Messages API 挂载 DeepSeek 原生 web 搜索，并逐次解析凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-deepseek

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-deepseek`，harness 可以通过 DeepSeek 原生搜索检索 web，使用部署已有的 `DEEPSEEK_API_KEY`。当部署希望使用 DeepSeek 原生搜索、并接受一次搜索在延迟与 token 上消耗一个完整模型轮次时选择它，因为 DeepSeek 不提供专用搜索端点。结果来自 DeepSeek 返回的结构化搜索块，绝不会从回复文本中抓取。凭据缺失时调用以结构化错误失败；响应缺少搜索结果块时会响亮地失败，而非降级。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `deepseek-official` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: deepseek-official` 固定。

### 何时选择

当部署希望使用 DeepSeek 原生服务端 web 搜索、且已持有 `DEEPSEEK_API_KEY` 时选择此后端——提供方复用该凭据引用。一次搜索比专用检索端点更重：DeepSeek 在完整模型轮次内执行搜索，因此每次搜索都要预期一次 Messages 调用的延迟与生成 token，每次请求最多 `maxUses` 次服务端搜索。当单次搜索的成本或延迟占主导时避免使用它。

### 最小配置

加载 web 服务与本提供方；密钥在已挂载 `ctx.credentials` 服务时从其解析，否则从进程环境解析。搜索端点使用 Anthropic 兼容基址（`https://api.deepseek.com/anthropic/v1`），不同于 LLM（大语言模型）适配器使用的 chat-completions 基址——绝不复用 `$DEEPSEEK_BASE_URL`。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://gateway.internal/anthropic/v1
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | DeepSeek API 密钥字面值；优先使用 `apiKeyEnv`，避免密钥进入配置。非空字面值优先 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；没有该服务时从进程环境解析。值缺失时调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败 |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Anthropic 兼容端点基址；追加 `/messages`。缺省时回退到 `$DEEPSEEK_SEARCH_BASE_URL`；无法解析时提供方不可用 |
| `model` | `deepseek-v4-flash` | Anthropic 格式模型名称 |
| `apiVersion` | `2023-06-01` | `anthropic-version` 标头值 |
| `maxTokens` | `4096` | Messages 请求生成 token 的正整数上限 |
| `maxUses` | `5` | 每次请求使用 `web_search` 服务器工具的正整数上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-deepseek)是每个受支持字段及其 JSDoc 的穷尽式真源。上面的条目是提供方 Settings 段的 base 层；叠加其上的用户层会作用于下一次搜索，因为提供方是按次投影该段，而不是在注册时固化它。

### 搜索返回什么

`content` 始终省略：DeepSeek 的提供方文本不作为答案受到信任。`sources[]` 来自 `web_search_tool_result` 块内的 `web_search_result` 条目——`url`、`title`、`publishedAt` 取自 `page_age`——snippet 在存在摘录时按 URL 关联的 `cited_text` 条目拼接。结果按 URL 去重，且由于 DeepSeek 不公开结果数量旋钮，服务通过截断并标记来强制执行 `maxResults`。

### 请求日志

由发起 agent（智能体）运行的搜索会在发出请求前一刻，追加仅用于日志的 `web/deepseek-search-llm-request` 会话事件。其中包含已解析端点、API 版本，以及发送给 DeepSeek 且不含密钥的精确 JSON 请求体；不包含标头和凭据。发出请求前发生凭据失败或取消时不会创建事件，而发出请求后的 HTTP 或响应失败会保留本次请求尝试的持久记录。

### 失败与恢复

失败抛出携带可按机器路由 code 的 `WebError`：凭据缺失为 `WEB_PROVIDER_CREDENTIAL_MISSING`，调用方取消为 `WEB_ABORTED`，提供方或传输失败，包括响应中没有 `web_search_tool_result` 块，为 `WEB_PROVIDER_ERROR`。HTTP 重定向会在接触 `Location` 指向的目标之前被拒绝。请求发出后的每项失败都会指出已解析的搜索端点，并说明搜索端点配置独立于聊天端点。如果该端点不符合用户预期，错误消息会要求会话模型指导用户进入 Settings > Plugins > Plugin configuration > Web search，修改 Endpoint 字段并保存。该页面不可用时，消息会把 `DEEPSEEK_SEARCH_BASE_URL` 和 `web-search-deepseek.baseURL` 作为部署配置方式。模型不得替用户选择或修改端点。面向模型的 `web_search` 工具会在自己的错误包装层内呈现这段文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本提供方建立在两项承诺之上：

- **只取结构化块。** DeepSeek 在服务端执行搜索并返回结构化的 `web_search_tool_result` 块；提供方解析这些块，绝不从模型文本中抓取 URL。严格模式下，没有此类块的响应会抛出 `WEB_PROVIDER_ERROR`，而非降级。
- **一个凭据，逐次解析。** 提供方复用 `DEEPSEEK_API_KEY` 引用（不新增密钥），但不复用 `$DEEPSEEK_BASE_URL`，因为搜索使用 Anthropic 兼容 Messages API。已挂载的凭据服务具有权威性；没有该服务时回退到启动进程的环境。按次解析意味着在 Web 的 Models 页中存储或轮换的密钥无需重启，即可用于下一次搜索。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、Settings 段安装、逐次选项投影 |
| [`src/provider.ts`](src/provider.ts) | `DeepSeekSearchProvider`：Messages 请求分发、块解析、引用拼接、凭据解析 |
| [`src/types.ts`](src/types.ts) | 搜索响应的 Anthropic 协议类型 |
| — | 不发布运行时不变式伴生入口；约定在服务处强制执行。 |

### 请求流程

每次搜索先把当前 Settings 段投影为提供方选项——端点、模型、密钥引用、上限——然后通过 `ctx.credentials`（或环境）解析凭据引用，追加仅用于日志的会话事件，并以原生 `web_search` 服务器工具分发 Messages 请求。响应中的 `web_search_tool_result` 块变为 `sources[]`；文本块中的 `cited_text` 条目按其 URL 拼接为 snippet；结果按 URL 去重；服务在返回路径上强制执行请求的来源上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-deepseek)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助 DeepSeek 搜索请求

#### 模型看到的内容

独立的 DeepSeek 模型会原样接收 `Perform a web search for the query: <query>` 作为用户文本，并收到一个原生 `web_search` 服务器工具定义。该请求不属于会话模型上下文。

#### Token 影响

每次搜索都会产生独立的提供方输入与输出 token；`maxTokens` 限制生成输出，`maxUses` 限制原生搜索次数。

#### KV Cache 影响

与会话请求缓存相互独立。辅助指令与原生工具定义可以形成稳定前缀，但查询或模型路由的每次变化都会阻止从首个差异起的复用。

### 间接的会话工具结果

#### 模型看到的内容

通过 `dsh-tool-web`，会话模型会看到结构化搜索块中去重后的 URL、标题、日期与引用 snippet；提供方文本不会作为答案受到信任。该提供方的具体失败消息包括带有处理指引的凭据缺失消息、`DeepSeek search credential resolution failed: <error>` 和 `DeepSeek search aborted`。请求、HTTP、原生搜索和响应正文失败会追加已解析端点及前述条件式配置指引。错误包装属于消费方。

#### Token 影响

注册不会直接产生会话 token。结果 token 随返回源与 snippet 增长，随后服务强制执行请求的来源上限。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下昂贵或不完整。它们是当前包约束。

- **一次搜索消耗一个完整的 Messages 模型轮次**——产生延迟与生成 token，最多执行 `maxUses` 次服务端搜索；DeepSeek 不公开专用检索端点。
- **动态凭据的可用性在操作内部解析**——同步可用性检查可以确认解析器存在，但无法查询异步凭据存储，因此选中的无密钥提供方会使搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败；稳定的 `web_search` schema 仍保持注册。
- **超量返回的来源仍消耗 token**——协议没有结果数量旋钮，`maxResults` 只能由服务在事后截断。
- **未引用的结果没有 `snippet`**——只有当文本块引用（`cited_text`）匹配其 URL 时，来源才会获得 snippet。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：专用检索端点

能够避免完整模型轮次的 DeepSeek 原生搜索端点将消除主要成本；在 DeepSeek 公开此类端点之前，本提供方仍是 Messages 调用适配器。

</details>
