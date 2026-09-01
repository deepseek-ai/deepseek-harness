---
description: "面向用户与维护者的 DeepSeek chat-completions 适配器说明：配置 deepseek-official 路由、thinking 与图片输入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-deepseek` 是 harness LLM 服务的 DeepSeek 直连适配器：它拥有 `deepseek-official` 提供方路由，并把 DeepSeek 的 chat-completions 协议格式翻译为 harness 的流式分片协议。借助它，组合可以流式调用 DeepSeek 模型，支持可配置的 thinking 与推理（reasoning）强度、向视觉模型发送图片，并浏览一份建议性模型目录。连接事实——端点、目录、密钥、thinking 策略——按请求解析，因此编辑用户设置文档即可改变下一个请求，无需重启。它是 DeepSeek 的两个结构不同适配器之一：pi-ai 孪生通过库与更多提供方服务自己的路由名，两者可以并排挂载。

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

当组合需要通过 harness LLM 服务流式调用 DeepSeek 模型时挂载本插件。它注册唯一的 `deepseek-official` 路由，并按请求解析连接事实，因此组合条目加可选用户设置分节即可驱动整个适配器。

### 何时选择

当部署面向 DeepSeek 官方 API（可选地通过 `baseURL` 指向的 OpenAI 兼容网关）时选择本适配器。当同一组合还要通过 pi-ai 目录路由其他提供方或手工声明的网关时，选择 `dsh-llm-pi-ai`；两个适配器可以同时挂载，因为它们的路由名不冲突。为 `deepseek-official` 注册任何其他适配器会以 `DUPLICATE_ADAPTER` 失败。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # credential reference, resolved per request
    baseURL: https://api.deepseek.com # optional; $DEEPSEEK_BASE_URL then this default
    reasoningEffort: high        # optional; off | low | high | max
    maxTokens: 256000            # optional per-request output cap
    maxRequestFilesBytes: 134217728
    maxInlineRequestImageBytes: 20971520
    maxImagesPerRequest: 600
    filesApiTimeoutMs: 60000
```

请求用 `provider: deepseek-official` 选择路由；模型 id 原样传到协议，因此新增 DeepSeek 模型无需重新注册。省略 `models` 时会公布适合专注任务、快速且经济的 `deepseek-v4-flash`，适合复杂或质量关键任务、能力更强且成本更高的 `deepseek-v4-pro`，以及支持图像的 `deepseek-v4-flash-vision-exp`；每个模型都有 1,000,000 token 上下文窗口。显式列表会替换这些默认值，未列出的模型 id 仍作为纯文本路由原样通过。包括模型发现工具在内的客户端可通过 `ctx.llm.listModels('deepseek-official')` 读取这些建议性条目。支持图片的条目可把 `imagePixelBudget` 设置为正整数或 `low`，也可以设置 `imageMaxBytes`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 按请求解析的凭据引用：先经凭据 seam，再到环境变量 |
| `baseURL` | `https://api.deepseek.com` | 端点基址；设置了 `$DEEPSEEK_BASE_URL` 时优先 |
| `thinking` | `enabled` | 部署策略；`disabled` 把所有请求锁定为 `off` |
| `reasoningEffort` | `high` | 默认强度：`off`、`low`、`high` 或 `max` |
| `maxTokens` | `256,000` | 单次请求输出上限；模型自身上限与显式请求值优先 |
| `defaultContextWindow` | `1,000,000` | 无精确值模型的容量回退 |
| `models` | V4 Flash + V4 Pro + V4 Flash Vision Exp | 供发现消费方查看的建议性目录 |
| `streamIdleTimeoutMs` | `300,000` | 单次流读取未完成的最大提供方空闲时间 |
| `maxRequestFilesBytes` | `128 MiB` | 按最旧优先卸载前保留的请求图片字节高水位 |
| `maxInlineRequestImageBytes` | `20 MiB` | 独立的 base64 回退高水位 |
| `maxImagesPerRequest` | `600` | 保留请求图片数量的高水位 |
| `imageOffloadByteQuantum` | `64 MiB` | Files 模式最旧前缀移除量子 |
| `inlineImageOffloadByteQuantum` | `10 MiB` | 内联模式最旧前缀移除量子 |
| `imageOffloadCountQuantum` | `20` | 数量超限移除量子 |
| `filesApiTimeoutMs` | `60,000` | 每张图片 Files 解析截止时间 |
| `fileExpiresAfterSeconds` | `604,800` | 请求的上传图片生存期 |
| `fileRefreshMarginSeconds` | `3,600` | 低于此剩余生存期时替换 id |
| `fileQuotaCleanupBatch` | `100` | 配额重试前删除的最旧 harness 文件数 |
| `retryPolicy` | normal，5 次重试 | 由 `dsh-llm-retry` 执行的提供方自有重试策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-deepseek)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 带 thinking 与图片的流式调用

支持图片的路由会在自身像素与字节预算内把每个持久引用解析为确定性请求版本。`imagePixelBudget` 接受正整数或 `low`；省略时使用总计 640,000 像素，`low` 使用总计 512×512 像素，`imageMaxBytes` 默认为 1 MiB。带 alpha 的图片使用 effort 0 的 WebP，不透明图片使用 JPEG，并采用 85/75/60 质量阶梯；全部候选都超过目标时保留最小输出。每张保留图片前都有文本，注明完整附件 id 与实际请求尺寸。当前文件系统可以映射附件提供方的宿主对象时，该文本还携带只读执行世界路径与可写副本使用的扩展名。纯文本与未列出路由接收稳定附件占位符，而持久历史继续保留图片引用。

适配器通常通过 DeepSeek Files API 上传这些确切请求字节，并发送 file-id 块。文件解析失败或超时会用相同请求版本的 base64 data URL 重建整份 chat 请求；一次请求绝不混用 file id 与内联图片。缓存 id 按端点与 API key 限定作用域，在到期前刷新，根据提供方的陈旧文件错误失效，并通过带等待方局部取消的 singleflight 解析。配额失败会先删除一批配置数量的最旧 harness 文件，再重试一次上传。

Files 模式通过 `maxRequestFilesBytes` 与 `maxImagesPerRequest` 限制保留请求版本；内联回退有独立 base64 预算。两种模式都按配置的字节或数量量子移除最旧前缀。每张省略图片都有自己的模型可见占位符，包含显示名或附件 id，以及可用时的规范化尺寸、媒体类型与当前只读路径。分阶高水位策略避免每新增一张图片都改写旧请求前缀。

`reasoningEffort` 选择公布的默认值。当部署策略允许 thinking 时，确切模型元数据会按顺序公开 `off`、`low`、`high` 与 `max` 强度及选择指引。`low`、`high` 与 `max` 启用 thinking 并以 `reasoning_effort` 序列化，适配器自有的 `off` 则发送 `thinking.type: disabled`。不支持的取值会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败；`thinking: disabled` 会在插件加载时拒绝任何非 `off` 强度。`purpose: 'session-title'` 的请求会强制关闭 thinking，把有界输出留给可见标题文本。

### 动态配置

连接事实通过可选 settings 与凭据 seam 每次操作重新读取一次。用户设置文档中的 `llm-deepseek:` 分节无需重启即可覆盖任何字段；未通过超 schema 上限的快照会保留最后有效事实并记录失败。API 密钥从提供端点、图片与 Files 策略及空闲预算的同一快照按流调用解析，因此被拒绝的设置代际不会贡献其中任何事实。图片请求在请求时解析附件服务，因此加载顺序不会冻结图片可用性。

### 提供方专用请求字段

存在 `ctx.deepseekLlmApiExtensions` 时，适配器会在 `fetch` 前根据确切序列化基础请求准备已注册顶层字段。准备或字段冲突在 HTTP 前失败；2xx 响应后，适配器会在消费 SSE 前接受每项已捕获贡献。传输与非 2xx 失败不会接受它们。随产品交付的组合用它提供可选增量 `dsh_session_log` 字段和默认启用的活跃 `dsh_plugin_packages` 清单；两者都留在模型输入之外。

### 失败与恢复

非 2xx 响应以稳定 code 失败：`AUTH`（401/403）、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER` 以及其他情况的 `HTTP_<status>`；响应前传输失败抛出 `TRANSPORT`，调用方中止抛出 `ABORTED`，流空闲超时抛出 `TIMEOUT`。请求扩展准备、字段冲突或 2xx 后接受失败使用 `REQUEST_EXTENSION`。当提供方未指出 file id 时，规范化图片拒绝会列出所有可能附件及其持久位置。陈旧文件拒绝会使点名映射（或该次尝试使用的全部映射）失效，并允许一次替换 chat 尝试。协议违规抛出 `STREAM_CLOSED` 或 `MALFORMED_RESPONSE`；不带内容块的终止 `stop` 变成 `EMPTY_RESPONSE`，默认重试策略会重试它。任何位置都没有密钥的请求以 `MISSING_CREDENTIAL` 失败；格式错误的凭据以 `INVALID_CREDENTIAL` 失败，并点名需要修复的引用——绝不包含密钥的任何部分。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

插件建立在一个显式解析步骤与一条注册事实之上。`resolveAdapterOptions()` 是从原始配置到已校验连接事实的唯一路径，适配器通过 thunk 每次操作重新读取这些事实——基址、目录、请求默认值、图片与 Files 策略及空闲预算都会作用于下一个请求，而进行中的流保持其启动时的事实。注册时捕获的唯一事实是重试策略：解析值变化时，插件会在一次同步分节中原位重新注册路由，因此任何请求都观察不到空档。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、按请求解析、settings 与凭据接线 |
| [`src/adapter.ts`](src/adapter.ts) | `DeepSeekAdapter`：模型解析、图片投影、Files 回退、带空闲超时的流式调用 |
| [`src/file-store.ts`](src/file-store.ts) + [`src/files-api.ts`](src/files-api.ts) | 限定作用域的上传缓存、到期、陈旧 id 恢复、配额清理与远程文件操作 |
| [`src/serialize.ts`](src/serialize.ts) | 协议序列化：thinking 默认值、Files 或内联图片块、历史规则 |
| [`src/sse.ts`](src/sse.ts) | 直接 `fetch` 流的 `eventsource-parser` SSE 分帧 |
| [`src/translate.ts`](src/translate.ts) | 把 SSE 载荷翻译为 harness `StreamChunk` 值 |
| [`src/types.ts`](src/types.ts) | 上述模块共享的协议级类型 |

### 协议流程

一次 `stream()` 调用通常发一条 chat 请求：解析确定性请求图片、优先使用 Files id、准备所有已注册顶层请求扩展、向解析后的 `baseURL` 发起 fetch、在 HTTP 2xx 后接受扩展事务，并把 SSE 流翻译为 harness 协议。文件解析失败会让首条 chat 使用内联模式；提供方的陈旧文件响应允许一次替换尝试，且替换解析失败时也使用内联模式。每条 chat 与 Files 调用都在模型输入之外携带共享归因和稳定匿名用户 id，会话调用还携带 session id。推理历史会按需序列化回请求，缓存计量则把 DeepSeek 的缓存命中指标映射进 harness 用量桶。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从服务约定逐步进入孪生适配器、重试执行器与共享类型。

- [dsh-llm 服务](../llm/README.zh.md)——本适配器注册其上的提供方无关服务。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——服务其他提供方与网关的库实现孪生。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定。
- [llm-retry](../llm-retry/README.zh.md)——应用本适配器 `retryPolicy` 的重试执行器。
- [DeepSeek 请求扩展](../deepseek-llm-api-extensions/README.zh.md)——提供方专用顶层字段的生命周期与接受语义。
- [会话日志上传](../../session/session-log-deepseek/README.zh.md)——可选的增量 `dsh_session_log` 贡献。
- [插件包清单](../plugin-package-inventory-deepseek/README.zh.md)——默认启用的 `dsh_plugin_packages` 贡献。
- [孪生 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.zh.md)——为什么 DeepSeek 交付两个结构不同的适配器。
- [强制应用归因标头](../../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.zh.md)——每个提供方请求携带的身份。

-----

<a id="model-experience"></a>
## 模型体验

### DeepSeek 请求

#### 模型看到什么

所选 DeepSeek 模型会收到 harness 系统提示词、消息历史、工具 schema、停止序列与调用配置（`maxTokens`、`reasoningEffort`、`temperature`），不包含适配器撰写的提示词散文。提供方专用请求扩展字段留在模型输入之外。视觉模型通常接收 Files API 引用形式的用户与工具结果图片，其旁带附件句柄和请求预览尺寸。当前执行文件系统可以映射附件提供方的宿主对象时，它还会收到规范化对象路径；描述符会把该副本标记为只读，并警告规范化可能缩放或重新编码上传内容。Files 解析失败时，全部保留图片改用内联 data URL；超出预算的较旧图片则在占位文本中保留当前请求已解析的访问方式。此前 assistant 轮次的推理内容会原样传回，无论该轮次是否调用了工具。

#### Token 影响

提供方分词决定精确的文本与图片 token 输入。适配器声明按路由的 `imageRequestPricing`：它根据持久字节长度复现最旧优先的图片 offload，并按投影后的尺寸使用官方公布的 v4 视觉计量（14px patch 网格、3:1 降采样、单图 384 token 上限、最坏对齐 pad）为每张保留图片计价。这使 token 计量服务可以在请求发出前为图片压力定价；上报的 usage 仍是权威值。推理回传会把每个推理轮次的思维链带进后续请求，而丢弃超预算图片会避免再次为它们付费。可用时报告缓存读取用量。`totalTokens` 是精确的 `prompt_tokens + completion_tokens` 汇总值；提供方给出的 `total_tokens` 不一致时省略该值。

#### KV Cache 影响

未改变的已组装前缀有资格获得 DeepSeek 缓存复用，本适配器会在用量中报告。确定性的请求图片字节并不会让完整前缀不可变化：执行世界路径变化会改写历史描述符文本，刷新上传会替换 `file_id`，Files 到 base64 的回退也会改变图片表示。这些变化以及模型路由、提示词、schema、历史或图片预算变化，都可能从首个受影响 token 起阻止复用；推理回传在每个推理轮次上追加内容。

### DeepSeek 响应

#### 模型看到什么

推理、文本与原始字符串工具参数会被翻译为 harness 分片，供 loop 记录并组装。

#### Token 影响

生成的 token 遵循请求中记录的推理强度与 `maxTokens`；只有 loop 保留的块会影响后续输入。

#### KV Cache 影响

loop 保留的响应块会追加到下一个请求，并保留其更早的可复用前缀；被丢弃的块不再有后续缓存影响。更换提供方或模型会选中不同的缓存域。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明适配器在哪里停止、由未来工作接续。它们是当前包约束，不是通用 DeepSeek 对比或任务积压。

- **设置中的 `models` 列表会整体替换组合列表**——设置层按字段合并，数组只算一个字段；按条目合并目录需要带键的形状。
- **不映射 `tool_choice`**——不属于核心词汇（与 pi-ai 孪生共享）。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`**——没有共享代理或拦截配置。
- **跳过插件新增的内容块类型**——核心文本与受支持图片块会被序列化，空工具输出以字面量 `(no output)` 过线。
- **图片是仅输入的持久附件**——不支持直接外部 URL 与 assistant 图片输出；DeepSeek 输入通常使用 Files API，仅在单次请求恢复时使用内联 base64。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- OpenRouter 专属应用归因标头延期到未来显式 OpenRouter 适配器或模式；OpenAI 兼容网关请求只携带共享归因基线。
- `off` 推理强度绝不会以 `reasoning_effort: 'off'` 过线；它序列化为 `thinking: { type: 'disabled' }` 并省略该字段，从而对拒绝未知强度取值的网关保持协议拼写有效。

</details>

**运行时不变式：** 不发布伴生入口。本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。
