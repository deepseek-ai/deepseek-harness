---
description: "通过同一官方提供方配置 DeepSeek Messages、Chat Completions 覆盖、推理与图片输入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek

[English](README.md) | 中文

## 概述

通过 `deepseek-official` 流式调用 DeepSeek 模型，默认使用 Messages，也可在 Cordis YAML 中选择 Chat Completions。两种协议共用凭据、端点配置、图片处理和模型目录。有效的设置更改在后续请求生效，进行中的请求保留原配置。Web 显示一个 DeepSeek 提供方，并提供 API 地址和密钥编辑。本包可与 [pi-ai 适配器](../llm-pi-ai/README.zh.md)并用。

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

当组合需要通过 harness LLM（大语言模型）服务流式调用 DeepSeek 模型时挂载本插件。它注册唯一的 `deepseek-official` 路由，并按请求解析连接事实，因此组合条目加可选用户设置分节即可驱动整个适配器。

### 何时选择

面向 DeepSeek 官方 API，或通过 `baseURL` 连接支持所选协议的网关时，选择本适配器。当同一组合还要通过 pi-ai 目录路由其他提供方或手工声明的网关时，选择 `dsh-llm-pi-ai`；两个适配器可以同时挂载，因为它们的路由名不冲突。为 `deepseek-official` 注册任何其他适配器会以 `DUPLICATE_ADAPTER` 失败。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # credential reference, resolved per request
    reasoningEffort: high        # optional; off | low | high | max
    maxTokens: 256000            # optional per-request output cap
    maxRequestFilesBytes: 134217728
    maxInlineRequestImageBytes: 20971520
    maxImagesPerRequest: 600
    filesApiTimeoutMs: 60000
```

请求用 `provider: deepseek-official` 选择路由；模型 id 原样传到协议，因此新增 DeepSeek 模型无需重新注册。省略 `models` 时公布支持文本和图像的 `deepseek-flash` 和 `deepseek-v4-flash-vision-exp`，以及仅支持文本的 `deepseek-v4-flash` 和 `deepseek-v4-pro`，各自的上下文窗口均为 1,000,000 token。显式列表会替换这些默认值，未列出的模型 id 仍作为纯文本路由原样通过。包括模型发现工具在内的客户端可通过 `ctx.llm.listModels('deepseek-official')` 读取这些建议性条目。支持图片的条目可把 `imagePixelBudget` 设置为正整数或 `low`，也可以设置 `imageMaxBytes`。当端点把 `messages` 中任意位置最新的 `system` 消息读作完整的有效系统提示词时，条目可以声明 `systemPromptUpdate: in-history`；适配器会在已解析模型与已准备调用上报告该模式，agent loop（智能体循环）随后把变化后的提示词追加到已缓存历史之后，而不是改写开头的 system 消息（[决策规则](../../core/agent-loop/README.zh.md#understand-the-implementation)）。默认的 `deepseek-flash` 条目声明该模式；其他模型需通过 `models` 显式声明，`in-history` 以外的任何值都会在加载时以 `llm-deepseek: catalog model "<id>" systemPromptUpdate must be "in-history" when present` 失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `protocol` | `messages` | Cordis YAML 中选择 `messages` 或 `chat-completions`；Web 不提供选择器 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 按请求解析的凭据引用：先经凭据 seam，再到环境变量 |
| `baseURL` | 按协议选择官方根地址 | 显式值优先，其次 `$DEEPSEEK_BASE_URL`，最后采用当前协议的官方端点 |
| `thinking` | `enabled` | 部署策略；`disabled` 把所有请求锁定为 `off` |
| `reasoningEffort` | `high` | 默认强度：`off`、`low`、`high` 或 `max` |
| `maxTokens` | `256,000` | 单次请求输出上限；模型自身上限与显式请求值优先 |
| `defaultContextWindow` | `1,000,000` | 无精确值模型的容量回退 |
| `models` | V41 Flash + V4 Flash + V4 Pro + V4 Flash Vision Exp | 供发现消费方查看的建议性目录 |
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

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-deepseek)是每个受支持字段及其 JSDoc 的穷尽式真源。

<a id="choose-a-protocol"></a>
### 选择协议

通过补丁为已有插件显式选择 Chat Completions：

```yaml
- id: llm-deepseek
  config:
    protocol: chat-completions
```

`protocol` 默认为 `messages`，官方根地址为 `https://api.deepseek.com/anthropic`；`chat-completions` 使用 `https://api.deepseek.com`。随产品交付的官方组合继承该默认值。两种协议都不要求填写 `baseURL`：当 `baseURL` 与 `$DEEPSEEK_BASE_URL` 均未设置时使用当前协议的官方默认值。切换协议保留已有端点覆盖，用户需要填写与选定协议兼容的地址。显式填写的 `https://api.deepseek.com` 是 Chat 根地址：删除该覆盖即可使用官方 Messages 默认值，也可以改填 `https://api.deepseek.com/anthropic`。Chat 追加 `/chat/completions`。Messages 与其 Files API 仅把末尾严格匹配的 `/v1` 路径段视为已有 Anthropic API 版本，并追加 `/messages` 或 `/files`；其他基址均追加 `/v1/messages` 或 `/v1/files`。因此，官方 Messages 根地址仍使用推荐的 `/anthropic/v1` 请求路径，同时不为任意版本式后缀提供兼容性。末尾斜线不改变这些结果。两种协议共用 `llm-deepseek` 设置、`apiKeyEnv` 与 `deepseek-official`，因此已保存的模型选择仍然有效。

Messages 以内容块发送文本、思考、工具调用和工具结果，以 `output_config.effort` 发送推理强度，并以 Files 引用或内联 base64 发送图片。声明 `systemPromptUpdate: in-history` 的模型保留初始顶层 system，在对应 user/tool-result 轮次之后发送新的 system 快照；未声明能力时，使用最新快照作为顶层 system。回放元数据记录 Messages 格式、模型和签名；Chat 请求只序列化持久化内容，不发送这些签名。无效的 Messages 回放元数据产生警告并省略签名，不丢弃文本或工具历史。

### 带 thinking 与图片的流式调用

支持图片的路由为每个持久引用选定请求目标，再把它解析为确定性请求版本。省略 `imagePixelBudget` 时按官方公布的视觉 token 网格定目标，即 14 px patch、3:1 降采样、单图最多 1024 token，因此正方形图片最多保留 1302×1302 像素，16:9 图片以 1708×961 发送、对应提供方 1708×966 的网格；正整数会用总像素预算取代网格，`low` 使用总计 512×512 像素。每张请求图片单边最多 4096 像素，这是提供方对包含 15 张及以上图片的请求的限制；`imageMaxBytes` 默认为 2 MiB。带 alpha 的图片使用 effort 0 的 WebP，不透明图片使用 JPEG，并采用 85/75/60 质量阶梯；全部候选都超过目标时保留最小输出。每张保留图片前都有文本，注明完整附件 id 与实际请求尺寸。当前文件系统可以映射附件提供方的宿主对象时，该文本还携带只读执行世界路径与可写副本使用的扩展名。纯文本与未列出路由接收稳定附件占位符，而持久历史继续保留图片引用。

两种协议通常通过各自的 DeepSeek Files 端点上传这些确切请求字节，并发送 file-id 引用。Messages 在配置的基址下使用 `/v1/files`，Files 请求与包含 file id 的 Messages 请求均携带 `anthropic-beta: files-api-2025-04-14`；Chat 使用 `/files`。Messages 模型请求与所有 Files 请求拒绝重定向，确保凭据仅发送到配置的源。文件解析失败或超时会按内联预算，用内联 base64 重建整份模型请求；一次请求绝不混用 file id 与内联图片。调用方取消会停止请求。

缓存 id 按端点与 API key 限定作用域，在到期前刷新，根据提供方的陈旧文件错误失效，并通过带等待方局部取消的 singleflight 解析。两种上传都通过 `expires_after[anchor]=created_at` 与 `expires_after[seconds]` 请求过期。Messages 文件元数据不含远端过期时间，因此本地复用期限使用原始上传时间加 `fileExpiresAfterSeconds`；这不保证远端文件删除。配额失败会先删除一批配置数量的最旧 harness 文件，再重试一次上传。

Files 模式通过 `maxRequestFilesBytes` 与 `maxImagesPerRequest` 限制保留请求版本；内联回退有独立 base64 预算。两种模式都按配置的字节或数量量子移除最旧前缀。每张省略图片都有自己的模型可见占位符，包含显示名或附件 id，以及可用时的规范化尺寸、媒体类型与当前只读路径。分阶高水位策略避免每新增一张图片都改写旧请求前缀。

`reasoningEffort` 选择公布的默认值。当部署策略允许 thinking 时，确切模型元数据会按顺序公开 `off`、`low`、`high` 与 `max` 强度及选择指引。`low`、`high` 与 `max` 启用 thinking，在 Chat Completions 中以 `reasoning_effort` 序列化，在 Messages 中以 `output_config.effort` 序列化，适配器自有的 `off` 则发送 `thinking.type: disabled`。不支持的取值会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败；`thinking: disabled` 会在插件加载时拒绝任何非 `off` 强度。`purpose: 'session-title'` 的请求会强制关闭 thinking，把有界输出留给可见标题文本。两种协议都转发显式 `temperature`；DeepSeek 在启用 thinking 时接受该参数，但忽略其值。

### 动态配置

连接事实通过可选 settings 与凭据 seam 每次操作重新读取一次。用户设置文档中的 `llm-deepseek:` 分节无需重启即可覆盖任何字段；违反 schema 之外约束的快照会保留最后有效事实并记录失败。API 密钥从提供端点、图片与 Files 策略及空闲预算的同一快照按流调用解析，因此被拒绝的设置代际不会贡献其中任何事实。图片请求在请求时解析附件服务，因此加载顺序不会冻结图片可用性。

### 提供方专用请求字段

两种协议中，存在 `ctx.deepseekLlmApiExtensions` 时，适配器都会在 `fetch` 前根据确切序列化基础请求准备已注册顶层字段。准备或字段冲突在 HTTP 前失败；2xx 响应后，适配器会在消费 SSE（Server-Sent Events）前接受每项已捕获贡献。传输与非 2xx 失败不会接受它们。随产品交付的组合用它提供默认启用的增量 `dsh_session_log` 字段和默认启用的活跃 `dsh_plugin_packages` 清单；两者都留在模型输入之外。

### 失败与恢复

非 2xx 响应以稳定 code 失败：`AUTH`（401/403）、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER` 以及其他情况的 `HTTP_<status>`；响应前传输失败抛出 `TRANSPORT`，调用方中止抛出 `ABORTED`，流空闲超时抛出 `TIMEOUT`。请求扩展准备、字段冲突或 2xx 后接受失败使用 `REQUEST_EXTENSION`。当提供方未指出 file id 时，规范化图片拒绝会列出所有可能附件及其持久位置。陈旧文件拒绝会使点名映射（或该次尝试使用的全部映射）失效，并允许一次替换模型请求。协议违规抛出 `STREAM_CLOSED` 或 `MALFORMED_RESPONSE`；不带内容块的终止 `stop` 变成 `EMPTY_RESPONSE`，默认重试策略会重试它。任何位置都没有密钥的请求以 `MISSING_CREDENTIAL` 失败；格式错误的凭据以 `INVALID_CREDENTIAL` 失败，并点名需要修复的引用——绝不包含密钥的任何部分。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

插件建立在一个显式解析步骤与一条注册事实之上。`resolveAdapterOptions()` 是从原始配置到已校验连接事实的唯一路径，适配器通过 thunk 每次操作重新读取这些事实——基址、目录、请求默认值、图片与 Files 策略及空闲预算都会作用于下一个请求，而进行中的流保持其启动时的事实。注册时捕获的唯一事实是重试策略：解析值变化时，插件会在一个同步区段内原位重新注册路由，因此任何请求都观察不到空档。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | settings、凭据与提供方注册 |
| [`src/config.ts`](src/config.ts) | schema 与请求配置解析 |
| [`src/adapter.ts`](src/adapter.ts) | 按协议分派，并冻结已准备请求的配置 |
| [`src/common/models.ts`](src/common/models.ts) | 共享模型目录 |
| [`src/common/model-info.ts`](src/common/model-info.ts) | 共享模型能力与推理选项 |
| [`src/common/file-store.ts`](src/common/file-store.ts) | 共享 Files 缓存、刷新、配额清理与取消 |
| [`src/common/files-api.ts`](src/common/files-api.ts) | 各协议的 Files 端点与响应映射 |
| [`src/protocols/chat-completions/adapter.ts`](src/protocols/chat-completions/adapter.ts) | Chat 传输、图片投影与请求扩展 |
| [`src/protocols/messages/adapter.ts`](src/protocols/messages/adapter.ts) | Messages 传输、图片投影、请求扩展与原生回放 |

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
- [强制应用归因标头](../../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.zh.md)——每个提供方请求携带的身份。

-----

<a id="model-experience"></a>
## 模型体验

### DeepSeek 请求

#### 模型看到什么

所选 DeepSeek 模型会收到 harness 系统提示词、消息历史、工具 schema、停止序列与调用配置（`maxTokens`、`reasoningEffort`、`temperature`），不包含适配器撰写的提示词散文。提供方专用请求扩展字段留在模型输入之外。视觉模型通常接收 Files API 引用形式的用户与工具结果图片，其旁带附件句柄和请求预览尺寸。当前执行文件系统可以映射附件提供方的宿主对象时，它还会收到规范化对象路径；描述符会把该副本标记为只读，并警告规范化可能缩放或重新编码上传内容。Files 解析失败时，全部保留图片改用内联 base64；超出预算的较旧图片则在占位文本中保留当前请求已解析的访问方式。此前 assistant 轮次的推理内容会原样传回，无论该轮次是否调用了工具。

#### Token 影响

提供方分词决定精确的文本与图片 token 输入。适配器声明按路由的 `imageRequestPricing`：把日志中的图片省略决策选中的每个出现位置按其占位文本计价，并按投影后的尺寸使用公开的视觉计量规则（14 px patch 网格、3:1 降采样、544×544 放大下限、单图 1024 token 上限）为每张保留图片计价。这使 token 计量服务可以在请求发出前为图片压力定价；上报的 usage 仍是权威值。推理回传会把每个推理轮次的思维链带进后续请求，而已省略的图片不再消耗视觉 token。保留的出现位置按精确请求版本字节超过 file 模式或内联回退预算（`maxRequestFilesBytes`、`maxImagesPerRequest` 与两个量子）的请求，以 `IMAGE_OFFLOAD_REQUIRED` 失败并说明还需省略多少最老的出现位置，由 `dsh-compaction-image-offload` 用 `image/offload` 事件记录所选位置并重试。可用时报告缓存读取用量。Messages 的 token 总数包含未缓存输入、输出、缓存读取与缓存写入 token。Chat Completions 使用 `prompt_tokens + completion_tokens`，提供方给出的 `total_tokens` 不一致时省略 `totalTokens`。

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

- Responses 协议尚未实现，配置值 `responses` 会被拒绝。

<a id="known-limitations-and-deferred-work"></a>


这些限制说明适配器在哪里停止、由未来工作接续。它们是当前包约束，不是通用 DeepSeek 对比或任务积压。

- **设置中的 `models` 列表会整体替换组合列表**——设置层按字段合并，数组只算一个字段；按条目合并目录需要带键的形状。
- **不映射 `tool_choice`**——不属于核心词汇（与 pi-ai 孪生共享）。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`**——没有共享代理或拦截配置。
- **跳过插件新增的内容块类型**——核心文本与受支持图片块会被序列化，空工具输出以字面量 `(no output)` 过线。
- **图片是仅用于输入的持久附件**——不支持直接外部 URL 与 assistant 图片输出；DeepSeek 输入通常使用 Files API，仅在单次请求恢复时使用内联 base64。
- 默认目录预注册 `deepseek-flash` 及其文本、图片和历史内更新能力，不探测网关可用性。网关开放该 ID 前，请求可能以 `INVALID_REQUEST` 失败。配置 `DEEPSEEK_API_KEY` 和支持该 ID 的网关后，设置 `DEEPSEEK_FLASH_E2E=1` 可启用[本包 e2e 测试文件](tests/adapter.e2e.ts)中的 Chat Completions 协议验证。
- [Messages system 更新 e2e](tests/messages/adapter.e2e.ts) 要求通过 `DEEPSEEK_IN_HISTORY_MODEL` 指定支持该能力的模型，例如 `deepseek-flash`，并使用 `high` 思考强度。该变量未设置或为空时跳过；普通 `off` 文本检查仍在有凭据时运行。关闭思考时已知的指令遵循不稳定，使这些 system 更新检查不适合使用 `off`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- OpenRouter 专属应用归因标头延期到未来显式 OpenRouter 适配器或模式；OpenAI 兼容网关请求只携带共享归因基线。
- `off` 推理强度绝不会以 `reasoning_effort: 'off'` 过线；它序列化为 `thinking: { type: 'disabled' }` 并省略该字段，从而对拒绝未知强度取值的网关保持协议拼写有效。

</details>

**运行时不变式：** 不发布伴生入口。本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。
