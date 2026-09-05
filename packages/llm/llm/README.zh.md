---
description: "面向用户与维护者的提供方无关模型调用服务说明：流式发起请求、注册提供方适配器或解析模型元数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm` 是位于 harness LLM 能力核心的提供方无关模型调用服务。任何向模型提供方发起流式请求的组合都会经过它，它拥有 agent loop（智能体循环）、会话日志和所有插件共同使用的共享词汇——消息、内容块、原始流式分片与紧凑 Assistant stream record。借助它，你可以注册提供方适配器、流式发起一次模型调用、列出与发现模型、解析精确模型元数据与调用默认值，并捕获每个提供方的重试策略；每个请求都会被记录，因此始终可以从会话日志重建。它不执行重试，也不拥有任何提供方协议逻辑：适配器翻译各自提供方的格式，可选包 `dsh-llm-retry` 在持久步骤边界上重跑失败的请求。请求在分发前会被深度冻结，因此 middleware 与适配器只能读取，绝不能改写。

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

任何调用模型提供方的组合——agent loop、会话标题生成器、压缩（compaction）摘要器——都会通过本服务流式发起请求。与至少一个提供方适配器一起挂载它；服务本身没有任何配置，也不包含提供方协议代码。

### 何时选择

当插件或组合需要调用模型时选择本包：它是进入提供方适配器的唯一受支持路径，并在 loop、会话日志与每个消费方之间保持同一套词汇。当需要提供方特定的协议行为（那属于 `dsh-llm-deepseek` 或 `dsh-llm-pi-ai` 之类的适配器）或重试执行（那属于 `dsh-llm-retry`）时，不要选择它。

### 最小组合

挂载服务与至少一个适配器，然后在每个请求中按名称选择提供方：

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
```

流会返回 token 级分片，并始终以一个终止 `finish` 分片结束。`BlockAssembler` 把分片组装为内容块与消息；`AssistantStreamAccumulator` 在紧凑表示中保留其精确时间戳与 token 边界，loop 再把它嵌入一个持久 attempt settlement：

```text
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }] })],
})) {
  // chunks: block-start, text-delta, ..., usage, finish
}
```

挂载成功后，`ctx.llm.listProviders()` 会按注册顺序报告已注册路由。

### 你可以做什么

- **流式发起一次模型调用**——`ctx.llm.stream(options)` 为任何已注册提供方与模型产出原始分片（token 级增量）；消费方用 `BlockAssembler` 组装。
- **注册提供方适配器**——一个适配器拥有一个或多个提供方路由，其注册会捕获该路由的重试策略；重复注册同一路由会以 `DUPLICATE_ADAPTER` 失败。
- **通过配置暴露并激活提供方**——适配器声明可配置提供方路由与 settings namespace，配置界面因此可以激活休眠提供方并编辑连接事实，无需重启。
- **发现与解析模型**——列出适配器公布的模型、询问端点它提供哪些模型，并解析某个精确模型的上下文窗口、输出默认值、推理（reasoning）强度与输入模态。
- **校验调用配置**——显式或配置的推理强度会在任何提供方 I/O 之前对照精确模型校验；请求省略输出上限时，会填入适配器配置的输出上限。

### 失败与恢复

每个流都恰好以一个终止 `finish` 分片结束：失败为 `{ kind: 'error', failure }`，取消为 `{ kind: 'aborted', failure }`。失败携带稳定 code，如 `NO_ADAPTER`、`MISSING_CREDENTIAL`、`AUTH`、`RATE_LIMIT` 与 `CONTEXT_WINDOW_EXCEEDED`；消费方依据 code 路由，绝不解析消息文本。点名未注册提供方的请求会以 `NO_ADAPTER` 失败，格式错误的凭据会以 `INVALID_CREDENTIAL` 失败，而不是表现为不透明的 fetch 错误。本服务从不自行重跑请求：重试是 `dsh-llm-retry` 在 agent 失败步骤扩展点上的职责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

服务建立在一个分离之上：**逻辑约定是提供方无关的，适配器拥有协议。** 它一次性地定义规范消息、内容块与流式分片词汇，每个提供方适配器只把自己的协议格式翻译为该词汇。注册表是拓扑的拥有者——适配器路由、可配置提供方条目与发现 offer 都在这里注册，并随其 fiber 一起 dispose（资源释放）——而请求始终是会话日志的纯函数：loop 构建的请求以深度冻结状态到达，因此监听器与适配器只能读取，绝不能改写。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LlmRuntime` 服务：适配器注册表、可配置提供方目录、模型发现、调用准备与流式边界 |
| [`src/types.ts`](src/types.ts) | `StreamChunk` 协议、内容块映射、结束原因与共享词汇 |
| [`src/message.ts`](src/message.ts) | 投递、历史与请求共享的不可变消息构造函数 |
| [`src/assembler.ts`](src/assembler.ts) | `BlockAssembler`：分片到块的增量组装 |
| [`src/assistant-stream.ts`](src/assistant-stream.ts) | 紧凑带时间 Assistant stream 的累积、严格校验与精确展开 |
| [`src/call-config.ts`](src/call-config.ts) | 调用配置校验、适配器默认值填入与请求冻结 |
| [`src/retry-policy.ts`](src/retry-policy.ts) | 提供方自有重试策略解析（normal 与 always 模式） |
| [`src/error.ts`](src/error.ts) | `HarnessError`/`LlmError` 分类体系与提供方无关失败 code |
| [`src/content.ts`](src/content.ts) | 共享图片内容辅助函数，包括请求图片卸载 |
| [`src/api-key.ts`](src/api-key.ts) | 每个适配器共享的凭据格式校验 |
| [`src/adapter-failure.ts`](src/adapter-failure.ts) | 把失败归一化为终止 finish 分片 |

### 主流程

请求会对照其精确模型的能力——上下文窗口、输出默认值、推理强度与输入模态——校验，填入任何适配器配置的默认值，然后整个请求被深度冻结。`prepareCall()` 把这些事实、分离的上下文与重试策略绑定到执行最终分发的精确适配器代次，因此 HMR 或动态设置无法把一个代次的图片能力与另一代次的端点混用。支持图片的适配器把持久引用投影为路由专用请求版本；`resolveImageAttachmentAccess()` 会单独把附件提供方的可选宿主对象映射进当前工具执行世界，而不改变请求图片或其 `variantId`。纯文本路由接收确定性的逐图片占位符，包括嵌套工具结果图片，而不会改写仅追加会话历史。持久 `FileBlock` 引用永远不会到达任何适配器：请求组装把每个引用（包括嵌套工具结果中的出现）替换为确定性 handle 文本，指出文件与其只读保存路径，路径经由挂载的附件与文件系统提供方解析。`ctx.llm.fileRequestText(ref)` 向请求计量公开相同的同步投影。`offloadRequestImagesWithPolicy()` 按原始字节或 base64 大小以及图片数或字节步长，确定性地从最旧图片开始移除；纯函数 `offloadedImagePrefixCount()` 公开同一决策，使路由所属的请求定价无需构建投影即可复现它。对视觉 token 收费的适配器声明按路由的 `imageRequestPricing`，`ctx.llm.imageRequestPricing(provider, model)` 为 token meter 同步解析它。分发经过 `llm/stream` waterfall，随后分片以 token 级增量返回，每个适配器结果都以唯一一个终止 `finish` 分片到达消费方。

### 不变式

- **模型可见 ⟺ 已记录**——到达提供方请求的任何内容都可以从会话日志重建；loop 构建的请求被深度冻结，绝不改写。
- **回放状态只在同一适配器内流动**——仅当同一适配器实例同时拥有历史路由与目标路由时，assistant 回放状态才会随行；否则在分发前被丢弃。
- **已准备调用是一次性的**——已准备调用只能分发一次，且其调用配置字段必须与准备好的配置一致。
- **图片投影遵循捕获的路由**——只有支持图片的模型会把持久 `ImageBlock` 引用转换为路由专用请求版本；纯文本模型接收稳定占位符。
- **文件投影无条件进行**——没有任何提供方会收到文件字节；每条路由对每个 `FileBlock` 都得到一行确定性 handle 文本，模型在需要时用文件工具读取保存的副本。
- **协议顺序**——`usage` 先于 `finish`，工具参数保持原始 JSON 字符串，终止 `finish` 之后不再有任何内容。
- **注册表变更具有原子性**——路由与目录注册会在任何变动前整体校验候选集合，因此被拒绝的变更会让此前状态继续服务。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享类型逐步进入具体适配器、重试执行器与计量服务。

- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——消息与块类型、紧凑 Assistant stream record、`StreamChunk` 协议与适配器约定。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——DeepSeek chat-completions 直连实现。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——基于 pi-ai 的多提供方实现。
- [llm-retry](../llm-retry/README.zh.md)——重跑失败模型请求的重试执行器。
- [Token 计量](../token-meter/README.zh.md)——具备回放感知的请求与上下文压力测量。
- [孪生 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.zh.md)——为什么 DeepSeek 路由交付两个结构不同的适配器。
- [LLM 流终止失败](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.zh.md)——模型请求结果与插件失败之间的服务边界。

-----

<a id="model-experience"></a>
## 模型体验

没有直接影响，因为 LLM 服务不添加内容；适配器决定何时添加本包导出的共享图片描述符与逐图片占位符。

#### KV Cache 影响

推理强度的具体化会保留已组装请求前缀。图片身份与请求预览文本是确定性的，可选执行世界路径则按请求解析；路径变化或图片卸载边界变化可能从该图片起阻止复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本服务在哪里停止、由其他包或未来工作接续。它们是当前包约束，不是任务积压。

- **本服务不提供重试执行、缓存或速率限制**——提供方注册会存储重试策略，但一次流仍是一次提供方尝试；`@deepseek-ai/dsh-llm-retry` 在持久 agent 步骤边界上执行该策略。
- **`GenerateOptions` 采样只包含 `temperature`／`maxTokens`／`stop`**——没有 `tool_choice`、`top_p` 或 penalty 字段；有产生方落地时词汇才会增长（见[已删除惰性旋钮](../../../.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md)）。
- **只有出现实际产生方后，相应变体才会加入**——`prefill`、逐工具 `strict`、内容块 `cache` 提示和 `agent` 消息来源变体都没有产生方（见 [Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)）。
- **`BlockAssembler` 只处理核心块类型**——插件添加块类型的流若从未由 `block-end` 关闭，`blocks()` 会抛出异常。
- **`GenerateOptions.sessionId` 是本地声明的品牌类型**——导入 dsh-session 的 `SessionId` 会产生依赖循环。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：开放问题与尚未决定的探索方向。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

#### 开放事项

- `GenerateOptions.sessionId` 是本地声明的品牌类型，因为导入 dsh-session 的 `SessionId` 会造成依赖循环；未来拥有 id 的包可以消除该权宜之计。
- 推理强度标识符是由适配器定义的不透明字符串，只对照各适配器公布集合解析；跨适配器共享强度词汇尚未决定。
- `llm/adapters-updated` 事件按设计不携带载荷；消费方重新读取注册表，而不是在事件中接收新拓扑。

</details>
