---
description: "配置 DeepSeek Messages、推理与图片输入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek

[English](README.md) | 中文

## 概述

提供共享的 DeepSeek Messages 传输、请求配置和模型能力。组合 [API key](../llm-deepseek-api-key/README.zh.md) 或[账号](../llm-deepseek-account/README.zh.md)插件以提供鉴权、模型发现与 provider 注册。有效的设置更改在后续请求生效，进行中的请求保留原配置。本包可与 [pi-ai 适配器](../llm-pi-ai/README.zh.md)并用。

`resolveAuth(connection)` 返回提供方持有的鉴权请求头，以及绑定本次请求凭据的可选失败回调。Messages 和 Files 直接使用这些请求头，不判断凭据类型。上传复用按端点和鉴权请求头的哈希隔离，不持久化原始凭据。

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

本包导出传输库；provider 插件向 harness LLM 服务注册路由。它在每次操作开始时从 Config 引用捕获连接选项。

适配器接受 LLM 服务的[仅供请求使用的 user 输入](../llm/README.zh.md#use-this-package)，并可将其与持久历史混用；省略请求输入的身份与来源不会改变提供方内容。

### 何时选择

面向 DeepSeek 官方 API，或通过 `baseURL` 连接兼容 Messages 的网关时，选择本适配器。当同一组合还要通过 pi-ai 目录路由其他提供方或手工声明的网关时，选择 `dsh-llm-pi-ai`；两个适配器可以同时挂载，因为它们的路由名不冲突。为 `deepseek-official` 注册任何其他适配器会以 `DUPLICATE_ADAPTER` 失败。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # credential reference, resolved per request
    reasoningEffort: high        # optional; off | low | high | max
    maxTokens: 256000            # optional per-request output cap
    maxRequestFilesBytes: 134217728
    maxInlineRequestImageBytes: 20971520
    maxImagesPerRequest: 600
    filesApiTimeoutMs: 60000
```

请求用 `provider: deepseek-official` 选择路由；模型 id 原样传到协议，因此新增 DeepSeek 模型无需重新注册。省略 `models` 时公布支持文本和图像的 `deepseek-flash`，以及仅支持文本的 `deepseek-v4-pro`，各自的上下文窗口均为 1,000,000 token。显式列表会替换这些默认值，核心调用中未列出的模型 id 仍作为纯文本路由原样通过。GUI 选择要求模型具有目录条目；条目消失后，已保存的选择仍可提交请求。包括模型发现工具在内的客户端可通过 `ctx.llm.listModels('deepseek-official')` 读取这些建议性条目。支持图片的条目可把 `imagePixelBudget` 设置为正整数或 `low`，也可以设置 `imageMaxBytes`。当端点把 `messages` 中任意位置最新的 `system` 消息读作完整的有效系统提示词时，条目可以声明 `systemPromptUpdate: in-history`；适配器会在已解析模型与已准备调用上报告该模式，agent loop（智能体循环）随后把变化后的提示词追加到已缓存历史之后，而不是改写开头的 system 消息（[决策规则](../../core/agent-loop/README.zh.md#understand-the-implementation)）。默认的 `deepseek-flash` 条目声明该模式；其他模型需通过 `models` 显式声明，`in-history` 以外的任何值都会在加载时以 `llm-deepseek: catalog model "<id>" systemPromptUpdate must be "in-history" when present` 失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://api.deepseek.com/anthropic` | 显式值优先，其次为 `$DEEPSEEK_BASE_URL`，最后为官方根地址 |
| `thinking` | `enabled` | 部署策略；`disabled` 把所有请求锁定为 `off` |
| `reasoningEffort` | `high` | 默认强度：`off`、`low`、`high` 或 `max` |
| `maxTokens` | `256,000` | 单次请求输出上限；模型自身上限与显式请求值优先 |
| `defaultContextWindow` | `1,000,000` | 无精确值模型的容量回退 |
| `models` | V4.1 Flash + V4 Pro | 供发现消费方查看的建议性目录 |
| `streamIdleTimeoutMs` | `300,000` | 单次流读取未完成的最大提供方空闲时间 |
| `maxRequestFilesBytes` | `128 MiB` | file 模式请求图片字节预算，保留图片超过时请求以 `IMAGE_OFFLOAD_REQUIRED` 失败 |
| `maxInlineRequestImageBytes` | `20 MiB` | 独立的 base64 回退高水位 |
| `maxImagesPerRequest` | `600` | 保留请求图片数量的高水位 |
| `imageOffloadByteQuantum` | `64 MiB` | Files 模式最旧前缀移除量子 |
| `inlineImageOffloadByteQuantum` | `10 MiB` | 内联模式最旧前缀移除量子 |
| `imageOffloadCountQuantum` | `20` | 数量超限移除量子 |
| `filesApiTimeoutMs` | `60,000` | 每张图片 Files 解析截止时间 |
| `fileExpiresAfterSeconds` | `604,800` | 请求的上传图片生存期与本地复用期限 |
| `fileRefreshMarginSeconds` | `3,600` | 低于此剩余复用期时替换 id |
| `fileQuotaCleanupBatch` | `100` | 配额重试前删除的、归 harness 所有的最旧文件数 |
| `retryPolicy` | normal，5 次重试 | 由 `dsh-llm-retry` 执行的提供方自有重试策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-deepseek-api-key)是每个受支持字段及其 JSDoc 的穷尽式真源。

启用[主动压缩](../../compaction/compaction-basic/README.zh.md#use-this-package)时，`models[].contextWindow`（未声明时使用 `defaultContextWindow`）必须大于生效请求的 `maxTokens` 与压缩策略 `headroomTokens` 之和。请求未覆盖输出上限时，使用模型的 `maxTokens` 或适配器默认值。小窗口部署应在容量范围内配置余量；降低 `thresholdRatio` 可以提早压缩。

<a id="endpoint-and-wire-format"></a>
### 端点与协议格式

官方根地址为 `https://api.deepseek.com/anthropic`。显式 `baseURL` 或 `$DEEPSEEK_BASE_URL` 提供兼容 Messages 的根地址。模型与 Files 请求分别追加 `/v1/messages` 和 `/v1/files`，但末尾严格匹配的 `/v1` 路径段会直接复用。末尾斜线不改变这些结果。基址必须使用 HTTP(S)，且不含凭据、查询或片段。

Messages 以内容块发送文本、思考、工具调用和工具结果，以 `output_config.effort` 发送推理强度，并以 Files 引用或内联 base64 发送图片。声明 `systemPromptUpdate: in-history` 的模型保留初始顶层 system，在对应 user/tool-result 轮次之后发送新的 system 快照；未声明能力时，使用最新快照作为顶层 system。回放元数据保留模型与思考签名。无效的回放元数据产生警告并省略签名，不丢弃文本或工具历史。 模型条目可声明 `toolUpdate: addition-only` 或 `in-history`；默认 `deepseek-flash` 条目声明 `addition-only`。投影后的 developer 工具更新转换为 system 角色的 `tool_addition` 和 `tool_removal` 块，引用已声明名称，延迟声明携带 `defer_loading`。包含这些块的请求发送 `mid-conversation-tool-changes-2026-07-01` beta 请求头。

### 账号凭据

`deepseek-official` 仅解析配置的 API Key 引用。`deepseek-account` 仅解析[账号提供者](../../credentials/deepseek-account-platform/README.zh.md)保存的授权，其允许的 `inferenceOrigin` 默认为 `https://api.deepseek.com`。两条路由均不回退到另一凭证。退出登录删除账号授权，保留 API Key。

Messages 和 Files 请求通过 `x-dsh-auth-token` 发送账号 token，不加 Bearer 前缀；API Key 使用 `x-api-key`。两种凭据模式均拒绝重定向。账号 provider 负责 HTTP 401 分类和凭据失效处理；传输层将错误交给其回调。

### 带 thinking 与图片的流式调用

支持图片的路由为每个持久引用选定请求目标，再把它解析为确定性请求版本。省略 `imagePixelBudget` 时按官方公布的视觉 token 网格定目标，即 14 px patch、3:1 降采样、单图最多 1024 token，因此正方形图片最多保留 1302×1302 像素，16:9 图片以 1708×961 发送、对应提供方 1708×966 的网格；正整数会用总像素预算取代网格，`low` 使用总计 512×512 像素。每张请求图片单边最多 4096 像素，这是提供方对包含 15 张及以上图片的请求的限制；`imageMaxBytes` 默认为 2 MiB。带 alpha 的图片使用 effort 0 的 WebP，不透明图片使用 JPEG，并采用 85/75/60 质量阶梯；全部候选都超过目标时保留最小输出。每张保留图片前都有文本，注明完整附件 id 与实际请求尺寸。当前文件系统可以映射附件提供方的宿主对象时，该文本还携带只读执行世界路径与可写副本使用的扩展名。纯文本与未列出路由接收稳定附件占位符，而持久历史继续保留图片引用。

适配器通常通过 `/v1/files` 上传这些确切请求字节，并发送 file-id 引用。Files 请求与包含 file id 的模型请求均携带 `anthropic-beta: files-api-2025-04-14`。全部请求拒绝重定向，确保凭据仅发送到配置的源。文件解析失败或超时会按内联预算，用内联 base64 重建整份模型请求；一次请求绝不混用 file id 与内联图片。调用方取消会停止请求。

缓存 id 按端点与凭据限定作用域，在到期前刷新，根据提供方的陈旧文件错误失效，并通过带等待方局部取消的 singleflight 解析。上传通过 `expires_after[anchor]=created_at` 与 `expires_after[seconds]` 请求过期。Messages 文件元数据不含远端过期时间，因此本地复用期限使用原始上传时间加 `fileExpiresAfterSeconds`；这不保证远端文件删除。配额失败会先删除一批配置数量的最旧 harness 文件，再重试一次上传。

Files 模式通过 `maxRequestFilesBytes` 与 `maxImagesPerRequest` 限制保留请求版本；内联回退有独立 base64 预算。两种模式都按配置的字节或数量量子移除最旧前缀。每张省略图片都有自己的模型可见占位符，包含显示名或附件 id，以及可用时的规范化尺寸、媒体类型与当前只读路径。分阶高水位策略避免每新增一张图片都改写旧请求前缀。

`reasoningEffort` 选择公布的默认值。当部署策略允许 thinking 时，确切模型元数据会按强度递增顺序公开 `off`、`low`、`high` 与 `max` 及选择指引。`low`、`high` 与 `max` 启用 thinking，并以 `output_config.effort` 序列化，适配器自有的 `off` 则发送 `thinking.type: disabled`。不支持的取值会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败；`thinking: disabled` 会在插件加载时拒绝任何非 `off` 强度。适配器转发显式 `temperature`；DeepSeek 在启用 thinking 时接受该参数，但忽略其值。

### 动态配置

连接选项在每次操作开始时从 volatile Config 引用捕获。Config 验证在表单持久化前拒绝无效候选值。凭据使用与端点、图像及 Files 策略、空闲预算相同的快照解析。附件服务在请求时解析。

### 提供方专用请求字段

存在 `ctx.deepseekLlmApiExtensions` 时，适配器会在 `fetch` 前根据确切序列化基础请求准备已注册顶层字段。注册表会省略准备失败的字段，字段冲突在 HTTP 前失败；2xx 响应后，适配器会在消费 SSE（Server-Sent Events）前接受每项已捕获贡献。传输与非 2xx 失败不会接受它们。基础请求连同扩展字段无法序列化时，适配器只发送基础请求并跳过接受，让贡献方在之后的请求中重发自身状态，同时记录一条列出被省略字段的告警。序列化、接受与回放降级告警每条路由只记录一次。随产品交付的组合用它提供默认启用的增量 `dsh_session_log` 字段和默认启用的活跃 `dsh_plugin_packages` 清单；两者都留在模型输入之外。

### 失败与恢复

配置仅接受 Messages，不提供 `protocol` 字段。若解析报告 `protocol is not configurable`，请从 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中 `llm-deepseek` 条目的 `config` 以及覆盖它的 home patch 或命令行 overlay 中删除 `protocol`，保留需要的 `baseURL`、`apiKeyEnv` 和 `models` 字段。已存储的配置若被适配器校验拒绝，后续请求会持续失败，直到配置修正；在模型设置卡中保存其他字段不会移除未知属性。请编辑配置文件，等待 profile 通过 HMR（热模块替换）重新加载；若未启用 HMR，则重启 profile。

成功的 Files 响应必须包含有效 JSON。上传、列举、获取和删除操作的 JSON 解码失败抛出 `INVALID_RESPONSE`，消息包含操作名称与 HTTP 状态，`LlmError.failure` 保留该状态，`cause` 保留原始解析错误。读取响应体时的传输和取消错误保留其原有身份。

非 2xx 响应以稳定 code 失败：`AUTH`（401/403）、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER` 以及其他情况的 `HTTP_<status>`；响应前传输失败抛出 `TRANSPORT`，调用方中止抛出 `ABORTED`，流空闲超时抛出 `TIMEOUT`。请求扩展字段冲突，或直接提供的 `prepareExtensions` 拒绝准备时，使用 `REQUEST_EXTENSION` 失败，并在消息中附上原因链；2xx 后接受失败只记录告警，响应仍会继续流式返回。当提供方未指出 file id 时，规范化图片拒绝会列出所有可能附件及其持久位置。陈旧文件拒绝会在一次上传索引更新中删除全部点名映射（或该次尝试使用的全部映射），并允许一次替换模型请求。协议违规抛出 `STREAM_CLOSED` 或 `MALFORMED_RESPONSE`；不带内容块的终止 `stop` 变成 `EMPTY_RESPONSE`，默认重试策略会重试它。官方路由缺少 API Key 的请求以 `MISSING_CREDENTIAL` 失败；格式错误的凭据以 `INVALID_CREDENTIAL` 失败，并点名需要修复的引用——绝不包含密钥的任何部分。

提供方插件负责目录可用性；仅账号路由要求存有凭据才能发现模型。两者的目录独立配置；传输层提供共享的默认模型元数据和能力解析。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

插件建立在一个显式解析步骤与一条注册事实之上。`resolveAdapterOptions()` 是从原始配置到已校验连接事实的唯一路径，适配器通过 thunk 每次操作重新读取这些事实——基址、目录、请求默认值、图片与 Files 策略及空闲预算都会作用于下一个请求，而进行中的流保持其启动时的事实。注册时捕获的唯一事实是重试策略：解析值变化时，插件会在一个同步区段内原位重新注册路由，因此任何请求都观察不到空档。

### 源码导航

[`src/index.ts`](src/index.ts) 导出协议库；[`src/host.ts`](src/host.ts) 为 provider 插件绑定共享 Host 服务。[`src/adapter.ts`](src/adapter.ts) 管理请求生命周期；[`src/serialize.ts`](src/serialize.ts) 和 [`src/translate.ts`](src/translate.ts) 映射模型输入与流式输出。[`src/file-store.ts`](src/file-store.ts) 通过 [`src/files-api.ts`](src/files-api.ts) 管理上传复用与恢复。

### 协议流程

一次 `stream()` 调用通常发一条模型请求：解析确定性请求图片、优先使用 Files id、准备所有已注册顶层请求扩展、向解析后的 `baseURL` 发起 fetch、在 HTTP 2xx 后接受扩展事务，并把 SSE 流翻译为 harness 协议。文件解析失败会让首条请求使用内联模式；提供方的陈旧文件响应允许一次替换尝试，且替换解析失败时也使用内联模式。每条模型与 Files 调用都携带共享归因。模型请求还在模型输入之外携带稳定匿名用户 id，并在存在 session id 时携带该值。推理历史会按需序列化回请求，缓存计量则把 DeepSeek 的缓存命中指标映射进 harness 用量桶。

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
- [会话日志上传](../../session/session-log-deepseek/README.zh.md)——默认启用的增量 `dsh_session_log` 贡献。
- [插件包清单](../plugin-package-inventory-deepseek/README.zh.md)——默认启用的 `dsh_plugin_packages` 贡献。
- [孪生 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.zh.md)——为什么 DeepSeek 交付两个结构不同的适配器。
- [强制应用归因标头](../../../docs/subsystems/llm-streaming.zh.md)——每个提供方请求携带的身份。

-----

<a id="model-experience"></a>
## 模型体验

### DeepSeek 请求

#### 模型看到什么

所选 DeepSeek 模型会收到 harness 系统提示词、消息历史、工具 schema、停止序列与调用配置（`maxTokens`、`reasoningEffort`、`temperature`），不包含适配器撰写的提示词散文。提供方专用请求扩展字段留在模型输入之外。视觉模型通常接收 Files API 引用形式的用户与工具结果图片，其旁带附件句柄和请求预览尺寸。当前执行文件系统可以映射附件提供方的宿主对象时，它还会收到规范化对象路径；描述符会把该副本标记为只读，并警告规范化可能缩放或重新编码上传内容。Files 解析失败时，全部保留图片改用内联 base64；超出预算的较旧图片则在占位文本中保留当前请求已解析的访问方式。此前 assistant 轮次的推理内容会原样传回，无论该轮次是否调用了工具。 对于非法 JSON 或非对象的历史工具参数，Messages 发送 `{}`。此参数兜底保留调用 ID、工具名和工具结果；原始参数仍保留在 Session 日志中。新生成的 Messages 工具参数仍须是有效 JSON 对象。 Messages 会省略用户消息和工具结果中的 `reasoning` 与 `tool-call` 块。这也允许回放包含助手输出的已保存子 Agent 通知；原始 Session 内容保持完整。转换后的空用户消息会被跳过，空工具结果则保留调用 id 和错误标记。其他不支持的输入块仍会以 `UNSUPPORTED_CONTENT` 失败。

#### Token 影响

提供方分词决定精确的文本与图片 token 输入。适配器声明按路由的 `imageRequestPricing`：把日志中的图片省略决策选中的每个出现位置按其占位文本计价，并按投影后的尺寸使用公开的视觉计量规则（14 px patch 网格、3:1 降采样、544×544 放大下限、单图 1024 token 上限）为每张保留图片计价。这使 token 计量服务可以在请求发出前为图片压力定价；上报的 usage 仍是权威值。推理回传会把每个推理轮次的思维链带进后续请求，而已省略的图片不再消耗视觉 token。保留的出现位置按精确请求版本字节超过 file 模式或内联回退预算（`maxRequestFilesBytes`、`maxImagesPerRequest` 与两个量子）的请求，以 `IMAGE_OFFLOAD_REQUIRED` 失败并说明还需省略多少最老的出现位置，由 `dsh-compaction-image-offload` 用 `image/offload` 事件记录所选位置并重试。可用时报告缓存读取用量。Messages 的 token 总数包含未缓存输入、输出、缓存读取与缓存写入 token。

#### KV Cache 影响

未改变的已组装前缀有资格获得 DeepSeek 缓存复用，本适配器会在用量中报告。确定性的请求图片字节并不意味着完整前缀固定不变：执行世界路径变化会改写历史描述符文本，刷新上传会替换 `file_id`，Files 到 base64 的回退也会改变图片表示。这些变化以及模型路由、提示词、schema、历史或图片预算变化，都可能从首个受影响 token 起阻止复用；推理回传在每个推理轮次上追加内容。在声明了 `systemPromptUpdate: in-history` 的目录条目上，同一请求序列延续期间的系统提示词变化会追加到已缓存历史之后，因此直到该历史末尾的前缀仍可复用；工具 schema 变化仍会从第一个改变的 token 起阻止复用。

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

- **替换 `models` 会替换完整目录列表**——修改单个模型条目时使用路径编辑。
- **不映射 `tool_choice`**——不属于核心词汇（与 pi-ai 孪生共享）。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`**——没有共享代理或拦截配置。
- **Messages 历史内 system 更新需要保留用户或工具结果轮次**——若更新后的全部用户输入都被省略，且前一个协议轮次是 assistant，序列化会在下一个 assistant 之前或请求结束处以 `UNSUPPORTED_CONTENT` 失败。文本或空工具结果可以保留该轮次。不支持将更新移到更早的轮次；[输入历史参考](README.zh.md)记录了排序约束。
- **图片是仅用于输入的持久附件**——不支持直接外部 URL 与 assistant 图片输出；DeepSeek 输入通常使用 Files API，仅在单次请求恢复时使用内联 base64。
- 默认目录公布 `deepseek-flash` 及其文本、图片和历史内更新能力，不探测网关可用性。网关开放该 ID 前，请求可能以 `INVALID_REQUEST` 失败。
- [adapter.e2e.ts](tests/adapter.e2e.ts) 与 [runtime.e2e.ts](tests/runtime.e2e.ts) 中的真实 API 检查需要 `DEEPSEEK_API_KEY`。将 `DEEPSEEK_IN_HISTORY_MODEL` 设为受支持的非空模型 ID 可运行 system 更新检查：适配器套件使用 `high` 思考强度，运行时套件则在关闭思考时比较缓存复用，可能受到指令遵循不稳定的影响。运行时图片用例还需要 `DEEPSEEK_FLASH_E2E=1` 或 `DEEPSEEK_VISION_E2E=1`。

<a id="dev-note"></a>
### 开发备注

无。

`deepseek-official` 仅使用配置的 API Key 引用；`deepseek-account` 仅在账号提供方允许的推理来源使用已保存的 DSH 授权。两条路由共享 Messages 传输，模型与文件设置独立配置。账号凭证缺失或不适用于目标时拒绝请求并提示登录；两条路由均不回退到另一凭证。Chat 和 Files 请求拒绝重定向。账号提供方根据运行中 Agent 已记录的请求上下文负责退登取消，包括工具执行阶段；传输层接收现有请求的中止信号。
