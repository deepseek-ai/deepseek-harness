# LLM（大语言模型）流式输出

[English](llm-streaming.md) | 中文

[`packages/llm`](../../packages/llm/README.zh.md) 提供对话与流式输出类型：每个请求和持久历史共用的 `Message`/`ContentBlock` 变体、完整组装的模型请求、原始 `StreamChunk` 协议、每个适配器必须实现的适配器约定（adapter contract），以及共享的 assembler。[核心包](core.zh.md)在每个轮次持有并记录这些值；本页声明它们。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

<a id="content-blocks-and-messages"></a>

## 内容块与消息

一段对话由 `Message` 组成；一条消息是一个类型化**内容块**的数组。块的联合类型从 `ContentBlockMap` 派生。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

```ts type-equiv
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'file': FileBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
```

各块接口（完整字段见源码）：`TextBlock`（`text`）、`ReasoningBlock`（thinking，区别于可见文本）、`ImageBlock`（一个持久的[图片附件](attachment.zh.md)）、`FileBlock`（一个持久的原样[文件附件](attachment.zh.md)，请求组装对每条路由都把它投影为 handle 文本）、`ToolCallBlock`（`id: ToolCallId`、`name`、原始 JSON `arguments`），以及 `ToolResultBlock`（`toolCallId`、嵌套 `content: ContentBlock[]`、`isError?`）。`ContentBlock = ContentBlockMap[ContentBlockType]`。仅当适配器、UI、压缩（compaction）和持久回放路径均支持某种新模态时，才将其纳入可合并扩展的 map。

图片访问方式属于请求序列化，不属于持久附件或确定性请求图片版本。`resolveImageAttachmentAccess()` 把附件提供方可选的宿主对象路径，与消费方为当前工具执行文件系统提供的映射组合起来。结果只适用于本次请求，不参与 `variantId`。

源码：[`packages/llm/llm/src/content.ts`](../../packages/llm/llm/src/content.ts)

```ts type-equiv
/** Execution-world path that model tools can use to read one normalized attachment. */
interface ImageAttachmentAccess {
  /** Absolute path to immutable normalized bytes; callers must treat it as read-only. */
  readonlyPath: string
}
```

源码：[`packages/llm/llm/src/message.ts`](../../packages/llm/llm/src/message.ts)

`Message` 是一个带标识且不可变的角色／来源／内容值。模型生成的 assistant 消息会在来源中记录生成它的提供方和模型，以及可选的适配器私有回放数据：

```ts type-equiv
/** Provider/model identity and adapter-private replay data for an assistant message. */
interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id that produced the message. */
  model: string
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmRuntime` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown
}
```

```ts type-equiv
/** One immutable message representation shared by delivery, durable history, and model requests. */
interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource
}
```

消息来源本身也是一个可合并扩展的和类型：

```ts type-equiv
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}
```

生产方标识与呈现形式相互独立。`kind` 回答「由谁产生」；可选的 `form` 回答「这是什么类型的信息」，消费方决定如何呈现。多个生产方可以共用一种 `form`，一个生产方在一次会话中也可以发出多种 `form`。这些取值描述语义，并逐个增加；未声明或无法识别的值使用文档规定的默认值，按不透明内容呈现：

```ts type-equiv
/**
 * The kind of information in producer-supplied context, declared by the
 * producer beside its provenance.
 *
 * `MessageSource.kind` answers *who produced this*; `form` answers *what kind
 * of thing it is*, and the two axes are deliberately independent — several
 * producers share one form, and one producer may emit more than one form over
 * a session.
 *
 * The vocabulary is SEMANTIC, never visual: a value states that the content is
 * a file's instructions or a catalog of available items, and a consumer decides
 * what that looks like. Colors, icons, ordering, and collapse defaults are the
 * consumer's business and must not enter this union. It grows one value at a
 * time as producers gain the structured fields their form needs; an absent or
 * unknown value is the documented default, presented as opaque content.
 */
type ContextForm =
  /** Instructions read out of workspace files the model is expected to follow. */
  | 'instructions'
  /** A catalog of items available in this session, republished as it changes. */
  | 'catalog'
  /** Current state, where a later snapshot from the same producer supersedes an earlier one. */
  | 'snapshot'
  /** A one-off account of something that just happened; it supersedes nothing. */
  | 'notice'
  /** A message another agent addressed to this one. */
  | 'relay'
  /** Material lifted out of another session's log, possibly reduced on the way in. */
  | 'recall'
```

```ts type-equiv
/** One named contribution to a `snapshot`-form context, in assembly order. */
interface ContextSnapshotSection {
  /** The contributing subsystem's name. */
  readonly name: string
  /** That contribution's model-facing text, exactly as assembled. */
  readonly text: string
}
```

```ts type-equiv
/**
 * Producer-declared {@link ContextForm} and the fields that form requires,
 * mixed into the source types that carry one.
 *
 * Discriminated by `form` so a producer cannot select a form without the
 * fields needed to present it: a `notice` must record its one-line
 * account, a `snapshot` its sections. Omitting `form` stays valid — an
 * undeclared context is the documented default.
 */
type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | {
    readonly form: 'snapshot'
    /** The named contributions this snapshot assembled, in order. */
    readonly sections: readonly ContextSnapshotSection[]
  }
  | {
    readonly form: 'notice'
    /** One-line account of what happened, shown without expanding the row. */
    readonly summary: string
  }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }
```

<a id="streamchunk--the-raw-protocol"></a>

## `StreamChunk`：原始协议

一个流式响应交错包含多种类型的块（文本、推理（reasoning）、多个工具调用）。`index` 将每个 delta 关联到其所属块；`block-end` 携带完整组装好的 `ContentBlock`，消费方无需自行重新组装 delta。这是一个**封闭的**可辨识联合类型：对 `type` 的 `switch` 以 `assertNever` 结尾，因此新增变体会在每个必须处理它的消费方处触发编译错误。

```ts type-equiv
/**
 * Adapter-private lossless-JSON state for replaying a successful response,
 * carried by a terminal `finish` chunk and stored on the assembled assistant
 * message's model source. Both halves stay opaque to the harness; only the
 * split is shared vocabulary, so assembly can keep stored metadata aligned
 * with stored content without reading either half.
 */
interface ReplayEnvelope {
  /** Response-level adapter-private metadata (ids, native stop reason). */
  response: unknown
  /**
   * Per-block adapter-private metadata, one entry per emitted block in
   * first-seen stream order. When assembly drops a block it drops the entry at
   * the same position; entries whose length does not match the emitted block
   * count discard the whole envelope. An adapter whose metadata is independent
   * of block structure omits this field and the envelope passes through
   * assembly unchanged.
   */
  blocks?: readonly unknown[]
}
```

```ts type-equiv
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. An adapter implementation
 * may throw, but `LlmRuntime.stream()` normalizes that failure to a terminal
 * `error` or `aborted` finish before exposing it to consumers.
 */
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
    replayState?: ReplayEnvelope
  }
```

<a id="compact-assistant-streams"></a>

## 紧凑 Assistant stream

`AssistantStreamAccumulator` 把每个 `StreamChunk` 与其原始安全整数时间戳配对，并生成 `AssistantStreamRecord[]`。同一 block 的连续 text、reasoning 或 tool argument delta 会变成一个 record，使用 `time0`、精确时间戳间隔和每个原始 delta 对应的一个数组成员；其他 chunk 保留为带时间戳的 raw record。该表示会移除重复 event envelope，但不会合并 token 边界，也不会丢弃 terminal、usage、block、failure 或 replay 事实。

`snapshot()` 返回分离且不可变的 stream。`expandAssistantStream()` 会严格检查 record key、成员数、index、时间戳、tool-call identity 与无损 JSON，再重建精确的带时间 chunk 序列。Session 日志会把该 stream 嵌入作为 surface result 的 `assistant/message`，或嵌入没有 surface message 的 `assistant/attempt`。

进程本地 `agent/assistant-stream` frame 承载实时呈现。持久回放、遥测、token 记账与历史 UI 组装会展开嵌入式 settlement，而不会把 live frame 当作持久事实。

<a id="llmfailure"></a>

## `LlmFailure`

每个抛出的失败或最终适配器的带内失败都会规范化为一种可序列化、提供方无关的 payload。`providerRetryAfterMs` 是经校验、由提供方请求的正数延迟，而不是重试决策；`ProviderRequestId` 是用于诊断的不透明品牌字符串。

```ts type-equiv
/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId
}
```

## 请求图片定价

提供方对请求图片收取视觉 token 的适配器通过覆写 `LlmAdapter.imageRequestPricing` 声明按路由的定价，消费方经 `ctx.llm.imageRequestPricing(provider, model)` 同步解析。token 计量服务在每次计量时解析路由模型的定价，使 compaction 的压力、保留与选段都按路由请求实际发送的形式为图片历史计价；DeepSeek 适配器复现自身的请求投影（按模型的像素预算、最旧优先 offload），并用官方公布的 v4 视觉计量为保留图片定价，已完成请求仍以 provider usage 为权威锚点。

```ts type-equiv
/**
 * Request price of one ordered image occurrence under one exact model route's
 * request projection. Every occurrence resolves to the pair the wire actually
 * carries: provider visual tokens for a retained image, plus the model-visible
 * text sent with or instead of it (request-preview handle, offload placeholder,
 * or text-only substitution). The caller prices `text` with its own text
 * estimator so provider pricing never fixes a text tokenization.
 */
interface LlmImageRequestPrice {
  /** Provider visual tokens for the retained request image; 0 when only text represents this occurrence. */
  visualTokens: number
  /** Model-visible text sent for this occurrence, to be priced by the caller's text estimator. */
  text: string
}
```

```ts type-equiv
/**
 * Provider-side request-image pricing for one exact model route. Implemented
 * by adapters whose provider charges visual tokens; consumers (the token
 * meter) resolve it synchronously per measurement, so implementations must not
 * perform I/O.
 */
interface LlmImageRequestPricing {
  /**
   * Price every image occurrence of one request projection.
   * @param images - durable image references in request order, one entry per occurrence.
   * @returns one price per occurrence, aligned by index with `images`.
   */
  priceImages(images: readonly ImageAttachmentRef[]): readonly LlmImageRequestPrice[]
}
```

## 适配器约定

每个适配器必须遵守以下规则，每个消费方可以依赖它们：

- **`usage` 在 `finish` 之前，`finish` 之后不再有任何分片。** 将两者都推迟到提供方的流结束标记，这样尾部的 usage-only 分片就不会违反顺序。
- **工具调用的 `arguments` 全程保持原始 JSON 字符串。** 部分片段通过 `argumentsDelta` 流式传输；如果提供方返回的是已解析的对象，适配器在 `block-end` 时重新序列化为字符串。
- **两条受支持的错误路径，共用一个 `LlmFailure` 类型。** 失败可以从 `stream()` 抛出（传输／协议错误），**或者**以 `finish {kind:'error'|'aborted', failure}` 结束流（无法在流中途抛异常的适配器用它表示提供方带内错误）。`LlmError.failure` 携带同一个 `LlmFailure`。调用选定适配器后，流会保留被抛出的确切 `Error` 对象，并将不可变事实以及实际服务注册所对应的不可变重试策略关联到该调用；agent loop（智能体循环）先把 attempt stream 提交为 `assistant/attempt`，再关闭失败步骤，并把错误、事实、不可变的先前已重试失败事实、实际服务策略和轮次信号提供给 `agent/request-error`。处理该错误的 listener 在其 await 的修复完成后返回 `{ kind: 'retry' }`；若未恢复，结构化失败会成为轮次错误，并且该次 attempt 不会提交 surface Assistant message 或工具副作用。
- **一次适配器调用就是一次提供方尝试。** 适配器禁用库重试。agent 层恢复会打开另一个持久、带编号的轮次；直接调用 `ctx.llm.stream()` 的调用方仍然只尝试一次。
- **提供方停顿在传输层受到时限约束。** 两个已交付的远程适配器都暴露正数且有限的 `streamIdleTimeoutMs`，默认五分钟。watchdog 只在 iterator `next()` 尚未完成时启动，整个请求使用同一个稳定 signal，把自身到期映射为 `TIMEOUT`，并把更早发生的调用方中止保留为 `ABORTED`。
- **上下文溢出只有一个规范 code。** 两个 DeepSeek 适配器都通过 `isContextWindowExceededError()` 对提供方的显式细节分类并暴露 `CONTEXT_WINDOW_EXCEEDED`，无论失败以抛出的 HTTP `LlmError` 还是带内 finish error 到达。消费方按 code 路由，绝不依赖提供方文本。
- **空 completion 是可重试错误，而不是静默的成功结果。** 两个适配器都把没有携带任何内容块的终止性 `stop` 结束映射为携带规范 `EMPTY_RESPONSE` code 的 `finish {kind:'error'}`，`dsh-llm-retry` 默认会重试它；详见[空模型响应可重试](../../.agents/notes/implemented/bug-fix/2026-07-24-empty-model-response-is-retryable.zh.md)。
- **每个提供方 HTTP 请求都携带应用归属头。** 适配器发送 `attributionHeaders()`（见下文）作为 `User-Agent` 基线，并通过协议级测试加以证明。
- **回放状态归适配器所有；其切分是共享词汇。** 成功的 `finish` 可以携带一个 `ReplayEnvelope`：不透明的响应级元数据，加上与发射块序列对齐的可选逐块条目。对齐关系是 harness 的词汇——组装丢弃某个块时，同一位置的条目一并丢弃，因此存储的元数据始终描述存储的内容。循环把裁剪后的数据与组装后的 assistant 消息一起存储。后续请求中，仅当历史提供方与目标提供方当前注册到完全相同的适配器实例时，`LlmRuntime` 才会传递该状态。该适配器负责校验状态并拥有所有跨模型或跨提供方转换；其他适配器只会收到提供方无关的内容以及提供方／模型字段，不会收到私有状态。持久化内容保持权威：读取适配器无法使用的已存状态只会把这一条消息降级为提供方无关转换并带出诊断，而不是让请求失败。

## `ResolvedRetryPolicy`

重试配置会在路由注册前解析为不可变的可辨识联合。normal mode 携带 `mode: 'normal'`、有限的 `maxRetries`、`retryableCodes`，以及必填的 `initialDelayMs`、`maxDelayMs` 与 `jitterRatio`；always mode 携带 `mode: 'always'` 和相同的必填退避字段，但没有有限上限。省略提供方策略时使用重试五次的 normal 默认值。分层 settings 在切换到 always 模式后可能保留仅属于 normal 的 `maxRetries` 或 `retryableCodes`；解析器会忽略这些未启用字段，并捕获纯 always 策略。`LlmRuntime.providerRetryPolicy(provider)` 返回注册值；调用选定实际提供服务的注册后，`llmRetryPolicyOf(stream)` 返回从中捕获的值，因此之后释放或替换路由都无法改变进行中失败的恢复策略。可选配置输入字段由[生成的配置目录](../config-catalog.zh.md)列出。

## `AppIdentity`：应用归属

每个适配器都会向提供方发送的静态公开应用标识（[`packages/llm/llm/src/attribution.ts`](../../packages/llm/llm/src/attribution.ts)）。`attributionHeaders(identity?)` 只把它映射到标准 `User-Agent` header；该约定有意不支持 OpenRouter 特有的应用归属 header。默认 `APP_IDENTITY` 从包 manifest（元数据清单）获取版本；每个字段都是公开产品事实——不含 secret、路径、会话 id 或逐用户标识，且任何逐请求信息都不得影响这些值。设计理由见[强制 `User-Agent` 归属](../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.zh.md)。

```ts type-equiv
/**
 * Static public application identity sent to LLM providers.
 *
 * Every field is a public product fact, safe on every request: no secrets,
 * local paths, session ids, prompt text, or per-user identifiers belong here,
 * and nothing per-request may influence the values.
 */
interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Repository home URL of the app, used as the `User-Agent` comment. */
  url: string
}
```

<a id="tokenusage"></a>

## `TokenUsage`

逐调用 token 记账。各计数**互不重叠**：`inputTokens` 只包含未缓存输入；缓存输入单独报告，计费输入是三者之和。若提供方把缓存命中折入单一提示词总数（如 DeepSeek 的 `prompt_tokens`），适配器会再将其扣除。可选的 `totalTokens` 是精确的提示词与输出聚合计数，由适配器保留提供方原值或从权威聚合计数重建；不可用或不一致时省略。`reasoningTokens` 存在时只是信息性细节，已经包含在 `outputTokens` 中；汇总时不得重复相加。

```ts type-equiv
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /**
   * Exact full-call total including aggregate prompt and output tokens.
   *
   * Adapters preserve a provider total or derive it from authoritative
   * aggregate prompt/output counters; they omit it when unavailable or
   * inconsistent.
   */
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

<a id="blockassembler"></a>

## `BlockAssembler`

`BlockAssembler`（[`packages/llm/llm/src/assembler.ts`](../../packages/llm/llm/src/assembler.ts)）是唯一的共享实现，负责把 `StreamChunk` 流折叠回 `ContentBlock`、usage、结束原因与回放状态。循环在记录原始分片的同时，把同一批分片送入 assembler，再将组装后的 assistant 内容连同生成它的提供方和模型一起存储。需要组装结果、又不想重新实现 fold 的消费方使用它。

内容与元数据共用同一次保留/丢弃决定：`max-tokens` 结束会丢弃每个工具调用，因为被截断的调用不能安全执行，而同一决定会在每个被丢弃的位置裁剪回放数据的逐块条目。无论组装移除什么，`blocks()` 与 `replayState` 都不可能不一致。

```ts public-api
/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * The agent loop feeds it while logging raw chunks for replay fidelity, then
 * reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
 * or `interruptedBlocks()` when cancellation cut the stream short.
 *
 * Tolerant of delta-only protocols (no block-start/end); deltas arriving for
 * an index already closed by `block-end` are ignored (malformed stream) so a
 * misbehaving adapter cannot grow memory or corrupt a completed block.
 */
declare class BlockAssembler {
  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next raw chunk, in stream order.
   */
  push(chunk: StreamChunk): void;
  /**
   * Assemble all blocks seen so far, in stream order.
   * @returns one block per seen index, except that max-token truncation drops
   *   tool calls that cannot be executed safely; an open block assembles from
   *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
   */
  blocks(): ContentBlock[];
  /**
   * Assemble the prefix an interrupted stream can safely finalize: closed and
   * open text/reasoning blocks with non-whitespace content, in stream order.
   * Tool calls are omitted because interruption precedes dispatch; retaining
   * one would require a fabricated result. Open unknown blocks are also omitted.
   * @returns the kept blocks; empty when nothing streamed before the interruption.
   */
  interruptedBlocks(): ContentBlock[];
  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined;
  /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason;
  /**
   * Replay metadata from the terminal finish chunk, if any, with per-block
   * entries pruned in step with {@link blocks}. Undefined when the envelope's
   * entries do not align with the emitted blocks.
   */
  get replayState(): ReplayEnvelope | undefined;
  /**
   * The assembled assistant message.
   * @param source - producer attribution for the assembled message.
   * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(source: MessageSource = { kind: 'plugin', plugin: 'dsh-llm/assembler' }): Message;
}
```

<a id="the-model-request-and-result"></a>

## 模型请求

一次模型调用是一个完全组装好的 `GenerateOptions`。适配器以原始 [`StreamChunk`](#streamchunk--the-raw-protocol) 流作答；消费方用 [`BlockAssembler`](#blockassembler) 组装它。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

提供方与模型发现使用小型、提供方无关的描述符。模型目录仅供参考：路由仍以已注册提供方为键。

注册适配器会返回一个句柄：既是释放器，也带有原子的路由替换——路由集合由用户配置决定的插件正需要它。

```ts type-equiv
/**
 * What {@link LlmRuntime.registerAdapter} returns: the disposer, plus an
 * atomic route replacement for the same adapter instance.
 */
interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void
  /**
   * Replace this registration's routes with `providers`, keeping the same
   * adapter instance. The candidate set is validated in full first — a
   * conflict with another adapter, an invalid name, or bad provider metadata
   * throws and leaves the current routes untouched — and the swap itself is
   * one synchronous section, so no request can observe a gap. An empty array
   * is legal here (a settings section that emptied holds zero routes while
   * staying registered), unlike an empty initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been released: its routes are gone and its disposer has already run,
   * so anything registered afterwards would have no owner left to release it.
   * @param providers - the complete next route set for this registration.
   */
  replace(providers: string[]): void
}
```

```ts type-equiv
/** Display metadata for one registered provider route. */
interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}
```

适配器插件还会通过 `registerConfigurableProviders()` 声明哪些路由*可以*运行，并指明每条路由的用户设置分节，使配置界面能在任何路由注册之前就呈现休眠的提供方。

```ts type-equiv
/**
 * One provider route an adapter plugin can activate through configuration,
 * whether or not the route is currently registered. Configuration surfaces
 * merge this directory with `listProviders()` to offer every configurable
 * provider alongside its live/dormant state.
 */
interface LlmConfigurableProvider {
  /** Provider route key this entry activates when configured. */
  provider: string
  /** Human-readable provider name for configuration surfaces. */
  displayName: string
  /** User-settings namespace whose section configures this provider. */
  settingsNs: string
  /**
   * Path from that namespace's section root to this provider's profile
   * object; empty when the whole section is the profile.
   */
  settingsPath: readonly string[]
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a gateway or self-hosted server it ships nothing about.
   * Absent means the adapter draws no such distinction; false means it does
   * and this route is one of its own. Only the adapter can answer: a stored
   * profile is how a user-added route AND a corrected shipped one both look
   * from outside.
   */
  declared?: boolean
}
```

```ts type-equiv
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable model name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
  /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
  inputModalities?: readonly ModelModality[]
}
```

对正确性敏感的元数据与参考目录分开解析，并归服务该确切路由的适配器所有。上下文容量、适配器调用默认值和推理选项共用同一个确切模型结果，消费方因而无需重复执行权威模型解析。

```ts type-equiv
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
}
```

推理强度是另一项针对确切路由的能力。核心为标识符添加品牌类型，但不枚举其值；有序集合、展示名称和可选的部署默认值均由各适配器持有。

```ts type-equiv
/** Adapter-owned identifier for one model's selectable reasoning effort. */
type ReasoningEffortId = Branded<'ReasoningEffortId'>
```

```ts type-equiv
/** Display metadata for one adapter-owned reasoning effort. */
interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId
  /** Human-readable effort name for selectors and diagnostics. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}
```

```ts type-equiv
/** Selectable reasoning efforts for one exact provider/model route. */
interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[]
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId
}
```

```ts type-equiv
/** Exact-route model metadata resolved by its owning adapter. */
interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo
}
```

```ts type-equiv
/** A single model request, fully assembled. */
interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * Session identity stamped by the loop for request routing. Replay uses it
   * to separate cursors; adapters may map it to model-hidden transport metadata.
   */
  sessionId?: Branded<'SessionId'>
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title'
}
```

模型响应为何停止由可合并扩展的原因表示。提供方终态失败携带流式约定的 [`LlmFailure`](#llmfailure)：

```ts type-equiv
/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
```

`FinishReason = FinishReasonMap[keyof FinishReasonMap]`。`TokenUsage`（逐调用计量，含不相交的缓存字段）详见[下文](#tokenusage)。

`GenerateOptions.tools` 携带 `ToolSchema`——工具的 JSON Schema 描述，发送给模型。它声明在 dsh-llm（而非 dsh-tools）中，正是因为它是循环每一步组装请求的一部分：

```ts type-equiv
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

面向模型的 `ToolSchema` 是协议类型；产出它的已注册 `ToolDefinition`（schema + `execute`）在 [tools.md](tools.zh.md) 中。

界面正在起草的提供方既没有路由也没有 catalog，因此询问被单独描述：请求携带用户正在编辑的草稿，回复是界面可以采纳的候选，而不是它必须服务的 catalog。

```ts type-equiv
/**
 * One interrogation of a provider endpoint that configuration has not stored
 * yet. Configuration surfaces send the draft a user is still editing, so the
 * request carries the endpoint and credential directly instead of naming a
 * route: a provider being added has no route to name.
 */
interface LlmModelDiscoveryRequest {
  /**
   * Route the draft is editing, when it edits an existing one. A route whose
   * adapter already knows its models answers from that knowledge instead of
   * asking the endpoint — the adapter's own registry is the better answer, and
   * it costs no network call.
   */
  provider?: string
  /**
   * Endpoint to interrogate. Optional because a route the adapter already
   * describes needs none; a route it does not must supply one.
   */
  baseURL?: string
  /** Wire protocol the endpoint speaks, when the draft names one. */
  api?: string
  /** Credential for this interrogation alone; the harness never stores it. */
  apiKey?: string
}
```

```ts type-equiv
/**
 * One model an endpoint reports about itself. Every field but the id is
 * optional because most provider listings disclose an id and nothing else;
 * a surface adopting one of these still owes the capacities its adapter needs.
 */
interface LlmDiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}
```

### 请求信封：`LlmCallConfig` 与记录的 header

循环从已记录状态构建每个请求。`EpochHeader` 记录调用配置，标记由适配器默认值提供的字段，并通过完整的 `request/header` 快照记录渲染后的提示词以及权威返回工具顺序（由 `toolOrder` 配置；未配置时按字典序）。结合派生历史，请求便可由会话日志重建。见 [session.md](session.zh.md#the-request-header-event-requestheader) 与[可重建性 Agent Note](../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.zh.md)。

`agent/request` 接收冻结的调用配置种子，并可返回替代值以切换提供方、模型、推理强度或采样参数。waterfall（瀑布式事件）开始前，循环会移除标记为适配器默认值的值，使确切模型准备过程填入所选路由的当前值；未带标记的显式设置仍保留在提议中。waterfall 结束后，准备过程会在轮次信号控制下拒绝显式指定但不受支持的推理强度 ID（不自动调整），并记录生效配置以及由适配器默认值提供的字段。准备完成的调用直至分派完成始终持有同一项适配器注册。到达 `llm/stream` 的请求会被深度冻结，因此变更会抛异常；请求还携带进程本地循环标识，使观察者不会把单独记录的冻结辅助调用误认成对话请求。

在协议中，循环构建的请求先读取 `system` slot（渲染后的提示词组装），再读取派生历史。已记录的请求快照会以最新的 `user/message`（轮次首步）或上一步的工具结果（后续步骤）结尾。开发不变式针对每个循环构建的请求精确重算此等式。

FIXME(call-config-shape)：重新审视其余哪些字段出于缓存目的确实属于 epoch 层级（`model` 和模型持有的推理强度已明确属于；采样标量目前出于谨慎保留在此）。

```ts type-equiv
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

```ts type-equiv
/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}
```

## DeepSeek 官方请求扩展

`ctx.deepseekLlmApiExtensions` 是用于向 `deepseek-official` 请求添加顶层字段的提供方特定注册表。贡献插件通过 `register(field, provider)` 认领一个字段；适配器在序列化基础正文后调用 `prepare(request)`，并在 HTTP 前合并返回字段。已准备的 `accept()` 事务会在 2xx 后运行，因此贡献方可以提交交付状态，而不会把传输失败或提供方拒绝当作接受。准备、冲突与接受失败会使用 `REQUEST_EXTENSION`，并使模型请求失败。

[协议参考](../deepseek-llm-api-wire-extensions.zh.md)定义确切的请求标头、扩展事务、字段版本和接收方义务。随附组合会将 [`dsh_session_log`](../../packages/session/session-log-deepseek/README.zh.md) 注册为无损增量权威日志后缀，并将 [`dsh_plugin_packages`](../../packages/llm/plugin-package-inventory-deepseek/README.zh.md) 注册为完整存活 Loader 包集合。这些字段仍位于模型消息之外，也不会进入 pi-ai 适配器路径。

## 服务与提供方约定

`LlmAdapter` 是提供方约定：创建子类、实现 `stream()`，再用 `ctx.llm.registerAdapter(providers, adapter)` 注册一个适配器实例。`GenerateOptions.provider` 选择已注册适配器；`GenerateOptions.model` 会传给该适配器，无需在生命周期启动时注册。重复提供方路由会原子失败。可选的 `providerRetryPolicy()` 会按路由捕获并填入 normal 默认值，`providerInfo()` 与异步 `listModels()` 方法则为 `LlmRuntime.listProviders()` / `listModels()` 提供分离的 selector 元数据。该目录仅供参考，不是请求白名单：适配器仍是权威，并可接受未列出的模型 id。单次异步 `resolveModel()` 查询返回确切模型身份，以及可选的对正确性敏感的上下文容量、适配器配置的 `defaultMaxTokens`、由模型持有的有序推理强度 ID 和可选的部署默认值；字段缺失表示元数据不可用或保留提供方持有的行为，而不表示目录成员关系无效。解析器会接收可选的取消信号，并且必须在信号中止后迅速完成结算。`LlmRuntime.resolveModelInfo()` 会校验聚合结果并返回分离值。在最终适配器边界，`resolveCallConfig()` 仅在 `maxTokens` 缺失时填入输出默认值，并校验和填入推理强度，因此直接调用也无法绕过任何一项已配置行为；直接分派会在等待解析前捕获一项适配器注册。agent loop 则使用 `prepareCall()`，使模型解析、请求头持久记录和分派全程使用同一项注册，保留来自同一次查询的分离上下文元数据，并报告适配器填入的配置字段。适配器查找发生在 `llm/stream` waterfall 的终端 continuation，因此 listener 可以在查找前短路调用，或路由一个可变的一次性请求。AgentLoop 在外层 waterfall 返回流句柄时观察到一次请求尝试；这个有限边界不能证明惰性终端适配器已构造完成或开始提供方 I/O。`block-start` / `block-end` 的 `index` 关联与 assembler 共同意味着适配器只需 emit 格式正确的分片——块重组不是每个适配器各自的问题。`ctx.llm.stream()` 与 `llm/stream` waterfall 在一个轮次中的位置见 [architecture.md](../architecture.zh.md#turn-flow)。

```ts type-equiv
/** One model call whose config and adapter registration were resolved together. */
interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Detached context metadata resolved with the registration-bound call. */
  readonly context?: LlmModelContext
  /** Exact model modalities captured with the adapter dispatch generation. */
  readonly inputModalities?: readonly ModelModality[]
  /** Config fields materialized by the captured adapter rather than proposed by the caller. */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

```ts public-api
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
 */
declare abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  /**
   * Resolve provider-side request-image pricing for one exact model route.
   * The default declares none, so consumers fall back to their own neutral
   * estimate. Implementations must answer synchronously without I/O; the
   * token meter resolves this per measurement.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @param _model - exact model id passed to {@link GenerateOptions.model}.
   * @returns route-owned image pricing, or `undefined` when the route declares none.
   */
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>;
  /**
   * Bind exact model metadata and the eventual request dispatch to one adapter generation.
   * Dynamic adapters override this so settings changes between preparation and
   * dispatch cannot combine one generation's capabilities with another's endpoint.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @param signal - cancellation for model resolution.
   * @returns model metadata and a one-generation stream entry point.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

`ContentBlockType`（带 `index` 关联的块所携带的键集合）从上文的 [`ContentBlockMap`](#content-blocks-and-messages) 派生。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdeepseekllmapiextensions--deepseekllmapiextensionregistry"></a>

### `ctx.deepseekLlmApiExtensions` — `DeepSeekLlmApiExtensionRegistry`

Registry of independently owned top-level fields for official DeepSeek requests.

```ts cordis-catalog
/**
 * Register the sole provider of one top-level request field. Registration is effect-scoped.
 * @param field - declaration-merged field owned by the provider.
 * @param provider - request-time field preparation and optional acceptance behavior.
 * @returns disposer that releases the field.
 */
register<K extends keyof DeepSeekLlmApiExtensionMap>( field: K, provider: DeepSeekLlmApiExtensionProvider<DeepSeekLlmApiExtensionMap[K]>, ): () => Promise<void>

/**
 * Prepare every currently registered field from one immutable base request.
 * Preparation failures reject before HTTP dispatch. Field values are cloned and frozen;
 * providers retain no mutable alias to the outgoing request.
 * @param request - exact serialized request facts before extension fields.
 * @returns detached fields and their idempotent joint acceptance transaction.
 */
async prepare(request: DeepSeekLlmApiExtensionRequest): Promise<PreparedDeepSeekLlmApiExtensions>
```

Source: [`packages/llm/deepseek-llm-api-extensions/src/index.ts`](../../packages/llm/deepseek-llm-api-extensions/src/index.ts)

<a id="ctxllm--llmruntime"></a>

### `ctx.llm` — `LlmRuntime`

The abstract `llm` service: an adapter registry plus a streaming model-call API, interceptable via the `llm/stream` waterfall.

```ts cordis-catalog
/**
 * Register an adapter for the given provider routes. Throws `LlmError` with code
 * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
 * Disposed with the fiber.
 * @param providers - every provider route this adapter should serve.
 * @param adapter - the adapter that streams calls for those providers.
 * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
 */
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle

/**
 * Describe provider routes with a registered adapter.
 * @returns detached provider metadata in registration order.
 */
@Remote listProviders(): LlmProviderInfo[]

/**
 * Declare provider routes an adapter plugin can activate through
 * configuration. Registration is all-or-nothing: an empty list, invalid
 * entry, or a provider already declared by any registration throws
 * `LlmError` without registering the rest. Disposed with the fiber.
 * @param entries - every configurable provider this plugin owns.
 * @returns a handle that withdraws all of them, and can atomically replace them.
 */
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle

/**
 * List every declared configurable provider, registered or dormant.
 * @returns detached directory entries in declaration order.
 */
@Remote listConfigurableProviders(): LlmConfigurableProvider[]

/**
 * Offer to interrogate provider endpoints on behalf of the settings
 * namespace this plugin owns. The namespace is the key because that is what
 * a configuration surface already holds from the configurable-provider
 * directory, and because a provider being *added* has no route to name yet.
 * Disposed with the fiber.
 * @param settingsNs - the namespace whose profiles this discovery serves.
 * @param discover - interrogates one endpoint and must honor the supplied signal.
 * @returns the disposer that withdraws the offer.
 */
registerModelDiscovery( settingsNs: string, discover: ( request: LlmModelDiscoveryRequest, signal?: AbortSignal, ) => Promise<readonly LlmDiscoveredModel[]>, ): () => void

/**
 * Interrogate one provider endpoint for the models it advertises. The
 * request describes a draft, not a stored route, so nothing here reads or
 * writes settings or credentials — the caller owns both, and the reply is
 * candidate metadata a surface may offer for adoption.
 * @param settingsNs - namespace whose registered discovery serves this draft.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param signal - caller cancellation.
 * @returns the advertised models, deduplicated in endpoint order.
 */
async discoverModels( settingsNs: string, request: LlmModelDiscoveryRequest, signal?: AbortSignal, ): Promise<LlmDiscoveredModel[]>

/**
 * Remote adapter for one draft provider interrogation.
 * @param settingsNs - namespace whose registered discovery serves this draft.
 * @param request - endpoint, protocol, and one-shot credential to use.
 * @param signal - caller cancellation supplied by the Remote carrier.
 * @returns advertised models in endpoint order.
 * @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
 */
@Remote('discoverModels') async remoteDiscoverModels( settingsNs: string, request: LlmModelDiscoveryRequest, signal: AbortSignal, ): Promise<LlmDiscoveredModel[]>

/**
 * Resolve the retry policy captured when one provider route was registered.
 * @param provider - registered provider route to inspect.
 * @returns the provider-owned policy, with normal defaults already resolved.
 */
providerRetryPolicy(provider: string): ResolvedRetryPolicy

/**
 * Resolve provider-side request-image pricing for one exact route, or
 * `undefined` when the provider is unregistered or declares none. Unknown
 * providers degrade to `undefined` rather than throwing because callers
 * price durable history whose route may no longer be mounted.
 * @param provider - provider route named by a request header.
 * @param model - exact model id named by the same header.
 * @returns the owning adapter's image pricing for the route, when declared.
 */
imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined

/**
 * Resolve the exact text one durable file occurrence contributes to every
 * provider request in the current execution environment.
 * @param ref - durable verbatim file reference from model history.
 * @returns the same deterministic handle text used at adapter dispatch.
 */
fileRequestText(ref: FileAttachmentRef): string

/**
 * Discover models advertised by one registered provider. Catalog membership
 * is advisory and never changes routing or request validation.
 * @param provider - registered provider route to inspect.
 * @returns detached model metadata in adapter-preferred order.
 */
async listModels(provider: string): Promise<LlmModelInfo[]>

/**
 * Resolve and validate all metadata from the adapter that owns one exact
 * route. The result is detached from adapter-owned objects; catalog
 * membership remains advisory and does not control request routing.
 * @param provider - registered provider route to inspect.
 * @param model - exact model id passed to the adapter.
 * @param signal - optional cancellation for adapter-owned asynchronous lookup.
 * @returns exact model identity plus available context and reasoning metadata.
 */
async resolveModelInfo( provider: string, model: string, signal?: AbortSignal, ): Promise<LlmResolvedModelInfo>

/**
 * Validate a conversation call config against its exact model capability and
 * materialize adapter-configured defaults. Unsupported explicit efforts
 * reject before provider I/O; no clamping or aliasing is performed. This
 * standalone query does not bind a later dispatch; use {@link prepareCall}
 * when logging and streaming must share one adapter registration.
 * @param config - provider/model route and optional request controls.
 * @param signal - optional cancellation for adapter-owned capability lookup.
 * @returns a detached config only when a default must be materialized.
 */
async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>

/**
 * Resolve one call under its current adapter registration. The returned
 * one-shot handle keeps that registration across header logging and dispatch,
 * so HMR cannot combine one adapter's capability result with another adapter.
 * @param config - provider/model route and optional request controls.
 * @param signal - optional cancellation for adapter-owned capability lookup.
 * @returns a prepared config and its registration-bound stream entry point.
 */
async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>

/**
 * Stream one model call as raw chunks (token-level deltas). Replay state is
 * retained only when the same adapter instance owns its historical provider
 * and the target provider. Final adapter selection remains fixed through
 * asynchronous exact-model resolution and dispatch. Adapter selection,
 * dispatch, and iteration failures become terminal `error` or `aborted`
 * finish chunks; middleware, nested-call, cleanup, and consumer failures
 * remain thrown.
 * @param options - the full request; `options.provider` selects the adapter.
 * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
 */
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

Types: [FileAttachmentRef](attachment.zh.md)

Source: [`packages/llm/llm/src/index.ts`](../../packages/llm/llm/src/index.ts)

<a id="llm-events"></a>

### `llm/*` events

<a id="llmadapters-updated--emit"></a>

#### `llm/adapters-updated` — emit

The provider topology changed: an adapter registered or unregistered routes, or the configurable-provider directory gained or lost entries. This payload-free registry notification fires at each commit point (including registration disposal); consumers re-read `listProviders()`, `listModels()`, or `listConfigurableProviders()` for the new state. Observer failures are contained and cannot veto the registry mutation.

```ts cordis-catalog
/**
 * The provider topology changed: an adapter registered or unregistered
 * routes, or the configurable-provider directory gained or lost entries.
 * This payload-free registry notification fires at each commit point
 * (including registration disposal); consumers re-read `listProviders()`,
 * `listModels()`, or `listConfigurableProviders()` for the new state.
 * Observer failures are contained and cannot veto the registry mutation.
 * @mode emit
 */
'llm/adapters-updated'(): void
```

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

<a id="llmstream--waterfall"></a>

#### `llm/stream` — waterfall

Waterfall around every streaming model call (retry, replay, routing). Bound to the LlmRuntime; call `next()` to reach the resolved adapter's stream, or yield your own chunks to short-circuit.

```ts cordis-catalog
/**
 * Waterfall around every streaming model call (retry, replay, routing).
 * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
 * adapter's stream, or yield your own chunks to short-circuit.
 * @param options - the full request. A LOOP-built request carries the
 *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
 *   (mutation throws): its content is a pure function of the session log (the
 *   reconstructability Agent Note), so listeners read it, never rewrite it.
 *   Hand-built calls do not carry that marker; their messages already obey
 *   the immutable creation contract.
 * @mode waterfall
 */
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

Source: [`packages/llm/llm/src/index.ts`](../../packages/llm/llm/src/index.ts)
<!-- END GENERATED cordis-surface -->
