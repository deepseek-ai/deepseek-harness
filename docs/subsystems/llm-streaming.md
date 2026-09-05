# LLM Streaming

English | [中文](llm-streaming.zh.md)

The conversation and streaming types from [`packages/llm`](../../packages/llm/README.md): the `Message`/`ContentBlock` variants every request and durable history share, the fully assembled model request, the raw `StreamChunk` protocol, the adapter contract every adapter must implement, and the shared assembler. The [core packages](core.md) hold and log these values on every turn; this page declares them.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

<a id="content-blocks-and-messages"></a>

## Content blocks and messages

A conversation is `Message`s; a message is an array of typed **content blocks**. The block union derives from `ContentBlockMap`.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

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

The block interfaces (full fields in source): `TextBlock` (`text`), `ReasoningBlock` (thinking, distinct from visible text), `ImageBlock` (a durable [image attachment](attachment.md)), `FileBlock` (a durable verbatim [file attachment](attachment.md) that request assembly projects to handle text for every route), `ToolCallBlock` (`id: ToolCallId`, `name`, raw-JSON `arguments`), and `ToolResultBlock` (`toolCallId`, nested `content: ContentBlock[]`, `isError?`). `ContentBlock = ContentBlockMap[ContentBlockType]`. A new modality belongs in the merge-extensible map only when its adapter, UI, compaction, and durable replay paths honor it.

Image access belongs to request serialization rather than the durable attachment or deterministic request-image version. `resolveImageAttachmentAccess()` combines the attachment provider's optional host object path with a mapping supplied by the consumer for the current tool execution filesystem. The result is available only for that request and does not participate in `variantId`.

Source: [`packages/llm/llm/src/content.ts`](../../packages/llm/llm/src/content.ts)

```ts type-equiv
/** Execution-world path that model tools can use to read one normalized attachment. */
interface ImageAttachmentAccess {
  /** Absolute path to immutable normalized bytes; callers must treat it as read-only. */
  readonlyPath: string
}
```

Source: [`packages/llm/llm/src/message.ts`](../../packages/llm/llm/src/message.ts)

A `Message` is one identified, immutable role/source/content value. Model-produced assistant messages name the provider and model that produced them and carry optional adapter-private replay data in their source:

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

Where a message came from is itself a merge-extensible sum type:

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

Producer identity and presentation form are independent. `kind` answers *who produced this*; the optional `form` answers *what kind of information this is*, and consumers decide how to present it. Several producers may share one form, and one producer may emit more than one form over a session. The values are semantic and grow one at a time; an absent or unrecognized value uses the documented default and is presented as opaque content:

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

## `StreamChunk` — the raw protocol

A streaming response interleaves several typed blocks (text, reasoning, multiple tool calls). `index` ties each delta to its block; `block-end` carries the fully-assembled `ContentBlock` so consumers don't have to re-assemble deltas themselves. It is a **closed** discriminated union — a `switch` over `type` ends with `assertNever`, so adding a variant breaks compilation at every consumer that must handle it.

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

## Compact Assistant streams

`AssistantStreamAccumulator` pairs each `StreamChunk` with its original safe-integer timestamp and produces `AssistantStreamRecord[]`. Consecutive text, reasoning, or tool-argument deltas for the same block become one record with `time0`, exact timestamp gaps, and one array entry per original delta; every other chunk stays a timestamped raw record. This representation removes repeated event envelopes without joining token boundaries or dropping terminal, usage, block, failure, or replay facts.

`snapshot()` returns a detached immutable stream. `expandAssistantStream()` strictly checks record keys, member counts, indexes, timestamps, tool-call identity, and lossless JSON before recreating the exact timed chunk sequence. The Session log embeds this stream in `assistant/message` for a surface result or `assistant/attempt` for an attempt with no surface message.

Process-local `agent/assistant-stream` frames carry live presentation. Durable replay, telemetry, token accounting, and historical UI assembly expand the embedded settlement instead of treating live frames as persisted facts.

## `LlmFailure`

Every thrown or in-band final-adapter failure normalizes to one serializable provider-neutral payload. `providerRetryAfterMs` is a validated positive delay requested by the provider, not a retry decision; `ProviderRequestId` is an opaque branded string for diagnostics.

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

## Request-image pricing

An adapter whose provider charges visual tokens for request images declares per-route pricing by overriding `LlmAdapter.imageRequestPricing`, and `ctx.llm.imageRequestPricing(provider, model)` resolves it synchronously for consumers. The token meter resolves the routed model's pricing on every measurement so compaction pressure, retention, and range selection price image history as the routed request actually sends it; the DeepSeek adapter reproduces its own request projection (per-model pixel budget, oldest-first offload) and prices retained images with the published v4 vision accounting, while provider usage remains the authoritative anchor for completed requests.

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

## The adapter contract

Every adapter MUST obey these, and every consumer may rely on them:

- **`usage` before `finish`, nothing after `finish`.** Defer both to the provider's end-of-stream marker so a trailing usage-only chunk can't violate the ordering.
- **Tool-call `arguments` stay raw JSON strings end-to-end.** Partial fragments stream via `argumentsDelta`; a provider that hands back parsed objects re-stringifies at `block-end`.
- **Two sanctioned error paths, one `LlmFailure` type.** A failure may either THROW from `stream()` (transport/protocol errors) **or** end the stream with `finish {kind:'error'|'aborted', failure}` (provider in-band errors, for adapters that can't throw mid-stream). `LlmError.failure` carries the same `LlmFailure`. After the call selects its adapter, the stream preserves the exact thrown `Error` object and associates immutable facts plus the serving registration's immutable retry policy with that call; the agent loop commits the attempt stream as `assistant/attempt`, closes the failed step, and offers the error, facts, immutable prior-retried facts, serving policy, and turn signal to `agent/request-error`. A handling listener returns `{ kind: 'retry' }` after its awaited repair; absent recovery the structured failure becomes the turn error, and no surface Assistant message or tool side effect is committed for that attempt.
- **One adapter call is one provider attempt.** Adapters disable library retries. Agent-level recovery opens another durable numbered turn; direct `ctx.llm.stream()` callers remain single-attempt.
- **Provider stalls are bounded at the transport.** Both shipping remote adapters expose positive finite `streamIdleTimeoutMs` with a five-minute default. The watchdog arms only while iterator `next()` is outstanding, uses one stable signal for the whole request, maps its own expiry to `TIMEOUT`, and keeps an earlier caller abort as `ABORTED`.
- **Context overflow has one canonical code.** Both DeepSeek adapters classify explicit provider detail through `isContextWindowExceededError()` and surface `CONTEXT_WINDOW_EXCEEDED`, whether the failure arrives as a thrown HTTP `LlmError` or an in-band finish error. Consumers route on the code, never provider text.
- **An empty completion is a retryable error, not a silent success.** Both adapters map a terminal `stop` finish that carried no content blocks to `finish {kind:'error'}` with the canonical `EMPTY_RESPONSE` code, and `dsh-llm-retry` retries it by default; see [empty model responses are retryable](../../.agents/notes/implemented/bug-fix/2026-07-24-empty-model-response-is-retryable.md).
- **Every provider HTTP request carries the app-attribution header.** Adapters send `attributionHeaders()` (below) - the `User-Agent` baseline - and prove it with a wire-level test.
- **Replay state is adapter-owned; its split is shared.** A successful `finish` may carry a `ReplayEnvelope`: opaque response-level metadata plus optional per-block entries aligned with the emitted block sequence. The alignment is the harness's vocabulary — when assembly drops a block it drops the entry at the same position, so stored metadata always describes stored content. The loop stores the pruned envelope with the assembled assistant message. On a later request, `LlmRuntime` passes the state only when the historical provider and target provider are currently registered to the exact same adapter instance. That adapter validates the state and owns any cross-model or cross-provider conversion; other adapters receive the provider-neutral content plus provider/model fields without the private state. Durable content stays authoritative: a stored state the reading adapter cannot use degrades that one message to provider-neutral conversion with a diagnostic instead of failing the request.

## `ResolvedRetryPolicy`

Retry configuration resolves before route registration into an immutable discriminated union. Normal mode carries `mode: 'normal'`, finite `maxRetries`, `retryableCodes`, and required `initialDelayMs`, `maxDelayMs`, and `jitterRatio`; always mode carries `mode: 'always'` and the same required backoff fields without a finite maximum. Omitting a provider policy uses the normal default of five retries. Layered settings may retain normal-only `maxRetries` or `retryableCodes` after switching to always mode; the resolver ignores those inactive fields and captures the pure always policy. `LlmRuntime.providerRetryPolicy(provider)` returns the registered value, and `llmRetryPolicyOf(stream)` returns the value captured from the serving registration after the call selects it, so later route disposal or replacement cannot change an in-flight failure's recovery policy. The [generated config catalog](../config-catalog.md) lists the optional input fields.

## `AppIdentity` — app attribution

The static public application identity every adapter sends to providers ([`packages/llm/llm/src/attribution.ts`](../../packages/llm/llm/src/attribution.ts)). `attributionHeaders(identity?)` maps it to the standard `User-Agent` header only; OpenRouter-specific app attribution headers are intentionally not supported by this contract. The default `APP_IDENTITY` sources its version from the package manifest; every field is a public product fact - no secrets, paths, session ids, or per-user identifiers, and nothing per-request may influence the values. Rationale: [Mandatory `User-Agent` attribution](../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md).

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

## `TokenUsage`

Per-call token accounting. Counts are **disjoint**: `inputTokens` is uncached input only; cached input is reported separately, and billed input is the sum of the three. Adapters whose providers fold cache hits into a single prompt total (DeepSeek's `prompt_tokens`) subtract them back out. Optional `totalTokens` is an exact aggregate prompt-plus-output count preserved from the provider or reconstructed from authoritative aggregate counters; adapters omit it when unavailable or inconsistent. `reasoningTokens`, when present, is informational detail already included in `outputTokens`; totals must not add it again.

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

## `BlockAssembler`

`BlockAssembler` ([`packages/llm/llm/src/assembler.ts`](../../packages/llm/llm/src/assembler.ts)) is the single shared implementation that folds a `StreamChunk` stream back into `ContentBlock`s, usage, finish reason, and replay state. The loop logs the raw chunks while feeding the same chunks through an assembler, then stores the assembled assistant content with the provider and model that produced it. A consumer that needs the assembled result without re-implementing the fold uses this.

One keep/drop decision covers content and metadata together: a `max-tokens` finish drops every tool call because a truncated call is unsafe to execute, and the same decision prunes the replay envelope's per-block entry at each dropped position. `blocks()` and `replayState` therefore cannot disagree, whatever assembly removes.

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

## The model request

One model call is a fully-assembled `GenerateOptions`. The adapter answers with a raw [`StreamChunk`](#streamchunk--the-raw-protocol) stream; the consumer assembles it with [`BlockAssembler`](#blockassembler).

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

Provider and model discovery uses small provider-neutral descriptors. A model catalog is advisory: routing still keys on a registered provider.

Registering an adapter returns a handle: the disposer, plus the atomic route replacement a plugin whose route set is user-configurable needs.

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

Adapter plugins additionally declare which routes *could* run through `registerConfigurableProviders()`, addressing each one's user-settings section, so configuration surfaces can offer dormant providers before any route registers.

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

Correctness-sensitive metadata is resolved separately from the advisory catalog and is owned by the adapter serving the exact route. Context capacity, adapter call defaults, and reasoning choices share one exact-model result so consumers do not repeat authoritative model resolution.

```ts type-equiv
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
}
```

Reasoning effort is another exact-route capability. The core brands identifiers but does not enumerate their values; each adapter owns the ordered set, display names, and optional deployment default.

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

Why a model response stopped is a merge-extensible reason. Terminal provider failures carry the streaming contract's [`LlmFailure`](#llmfailure):

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

`FinishReason = FinishReasonMap[keyof FinishReasonMap]`. `TokenUsage` (per-call accounting with disjoint cache fields) is detailed [below](#tokenusage).

`GenerateOptions.tools` carries `ToolSchema` — the JSON-schema description of a tool, as sent to the model. It is declared in dsh-llm (not dsh-tools) precisely because it is part of the request the loop assembles every step:

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

The model-facing `ToolSchema` is the wire type; the registered `ToolDefinition` that produces it (schema + `execute`) is on [tools.md](tools.md).

A provider a surface is still drafting has no route and no catalog, so interrogation is described separately: the request carries the draft the user is editing, and the reply is candidates a surface may adopt rather than a catalog it must serve.

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

### The request envelope: `LlmCallConfig` and the logged header

The loop builds each request from logged state. `EpochHeader` records call config, marks the fields supplied by adapter defaults, and records the rendered prompt and authoritative returned tool order (configured by `toolOrder`, or lexicographic when unset) through full `request/header` snapshots. Together with derived history, this makes the request reconstructable from the session log. See [session.md](session.md#the-request-header-event-requestheader) and the [reconstructability Agent Note](../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md).

`agent/request` receives a frozen call-config seed and may return a replacement to switch provider, model, reasoning effort, or sampling. Before the waterfall, the loop removes values marked as adapter defaults so exact-model preparation materializes the selected route's current values; unmarked explicit settings remain in the proposal. After the waterfall, preparation rejects unsupported explicit effort ids without clamping and logs the effective config plus the fields supplied by adapter defaults under the turn signal. The prepared call keeps one adapter registration through dispatch. Requests reaching `llm/stream` are deep-frozen, so mutation throws, and carry a process-local loop identity so observers do not confuse separately logged frozen auxiliary calls with conversation requests.

On the wire, a loop-built request reads the `system` slot (the rendered prompt assembly) followed by the derived history. The logged request snapshot ends with the newest `user/message` on a turn's first step and the previous step's tool results on later steps. The dev invariant recomputes exactly this equation against every loop-built request.

FIXME(call-config-shape): revisit which remaining fields are genuinely epoch-level for cache purposes (`model` and the model-owned reasoning effort are explicit; the sampling scalars sit here out of caution).

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

## Official DeepSeek request extensions

`ctx.deepseekLlmApiExtensions` is the provider-specific registry for additive top-level fields on `deepseek-official` requests. Contributor plugins use `register(field, provider)` to claim one field; the adapter calls `prepare(request)` after serializing its base body and merges the returned fields before HTTP. The prepared `accept()` transaction runs after 2xx, so a contributor can commit delivery state without treating a transport or provider rejection as acceptance. Preparation, collision, and acceptance failures use `REQUEST_EXTENSION` and fail the model request.

The [wire reference](../deepseek-llm-api-wire-extensions.md) defines the exact request headers, extension transaction, field versions, and receiver obligations. The shipped composition registers [`dsh_session_log`](../../packages/session/session-log-deepseek/README.md) as a lossless incremental canonical-log suffix and [`dsh_plugin_packages`](../../packages/llm/plugin-package-inventory-deepseek/README.md) as the complete active Loader-backed package set. These fields remain outside model messages and are absent from the pi-ai adapter path.

## Service and provider contracts

`LlmAdapter` is the provider contract: subclass, implement `stream()`, and register one adapter instance with `ctx.llm.registerAdapter(providers, adapter)`. `GenerateOptions.provider` selects the registered adapter; `GenerateOptions.model` is passed to that adapter and need not be registered at lifecycle start. Duplicate provider routes fail atomically. Optional `providerRetryPolicy()` is captured per route with normal defaults, while `providerInfo()` and asynchronous `listModels()` feed `LlmRuntime.listProviders()` / `listModels()` with detached selector metadata. That catalog is advisory rather than a request whitelist: the adapter remains authoritative and may accept unlisted model ids. One asynchronous `resolveModel()` query returns exact model identity plus optional correctness-sensitive context capacity, an adapter-configured `defaultMaxTokens`, and ordered model-owned reasoning ids with an optional deployment default; absent fields mean unavailable metadata or provider-owned behavior, not invalid catalog membership. The resolver receives optional cancellation and must settle promptly after abort. `LlmRuntime.resolveModelInfo()` validates and detaches the aggregate. At the final adapter boundary, `resolveCallConfig()` materializes the output default only when `maxTokens` is absent and validates and materializes reasoning, so direct calls cannot bypass either configured behavior; direct dispatch captures one registration before awaiting that resolution. The agent loop instead uses `prepareCall()` to keep the same registration across model resolution, durable header logging, and dispatch, retain detached context metadata from that exact lookup, and report which config fields the adapter defaulted. Adapter lookup happens at the terminal continuation of the `llm/stream` waterfall, so a listener may short-circuit the call or route a mutable one-shot request before lookup. AgentLoop observes a request attempt once the outer waterfall returns a stream handle; that limited boundary does not prove a lazy terminal adapter was constructed or began provider I/O. The `block-start` / `block-end` `index` correlation and the assembler together mean an adapter only has to emit well-formed chunks — block reassembly is not each adapter's problem. [architecture.md](../architecture.md#turn-flow) shows where `ctx.llm.stream()` and the `llm/stream` waterfall sit in one turn.

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

`ContentBlockType` (the key set the `index`-correlated blocks carry) derives from [`ContentBlockMap`](#content-blocks-and-messages) above.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [FileAttachmentRef](attachment.md)

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
