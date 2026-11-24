# 朗读

[English](read-aloud.md) | 中文

实验性朗读把一条已完成的助手回复读出来。它包含三个角色：[服务定义](../../packages/experimental/text-to-speech/README.zh.md)把文本路由到具名的合成 Provider，[DeepSeek Provider](../../packages/experimental/text-to-speech-deepseek/README.zh.md)调用云端接口，[Remote 消费者](../../packages/experimental/read-aloud/README.zh.md)为浏览器规划并合成回复。[可选 Bundle](../../packages/experimental/read-aloud-bundle/README.zh.md)把它们与[消息按钮](../../packages/experimental/client-ui-read-aloud/README.zh.md)组合起来。

## 合成 Provider

`SynthesisProviderId` 为注册标识添加类型品牌。`SynthesisProviderInfo` 携带显示名称、`host-local` 或 `cloud` 处理位置、Provider 的 16 位单声道 PCM 的采样率、`maxCharacters`（一次调用接受的最长文本），以及 `voices`（它提供的音色 id）。`SynthesisRequest` 包含文本和可选的音色；`resolve()` 应用配置的 Provider 和保存的音色，返回捕获该 Provider 实例和音色的 `SynthesisSpec`。缺失的 Provider 和超过上限的文本会明确报错，文本不会回退到其他地方。

`SynthesisProvider.synthesize()` 接收完整的 `SynthesisInput` 与 `AbortSignal`，以异步可迭代对象返回音频，各块可以在字节流的任意位置切分。Provider 以带有 `SynthesisFailureCode` 的 `SpeechSynthesisError` 报告已分类的失败。`SynthesisAvailability` 为 `ready`、带原因的 `unavailable`，或带 Host 诊断信息的 `failed`；`SynthesisSnapshot` 把每个 Provider 的可用状态与配置的 id 放在一起。注销注册会中止它的流，并且只等待仍在进行的 Provider 调用。

## 控速

合成接口对提交的每个字符计费，合成速度又远快于朗读速度，所以朗读从不提交听者还没听到的文本。`ReadingPlan` 以 `ReadingSegment` 区间列出回复的各段，区间指向它的朗读文本，每段估算为 `segmentSeconds` 的朗读时长，并在句末收段。一个 `SegmentRequest` 合成一段。Client 在持有的音频剩余可播放时长不超过 `dispatchBelowMs` 时请求下一段，停止会取消进行中的请求。因此，提前停止只为已经请求的段计费，之后的内容不计费。

## 音色

Provider 列出自己的音色，第一个是默认音色。`SynthesisSelectionPatch` 把一个音色保存到注册表的 profile 条目，`SynthesisProviderView` 报告实际使用的音色：Provider 提供保存的音色时用它，否则用默认音色。合成接口根据文本识别语种，也没有语速参数，所以这两项都不能选择。

配置的 Provider 已注册时，`ReadAloudStatus` 携带 `SynthesisFacts`：音色列表、保存的音色和采样率。Bundle 详情据此列出音色，并保存一个 `VoiceSelection`。`ReadingPlan` 在生成时确定音色，每个 `SegmentRequest` 都带着它，所以一次朗读只用一个音色，之后的选择在下一次朗读生效。`SampleRequest` 用一个音色朗读 Host 固定的一句话，听者不必朗读回复就能比较音色。

## 浏览器与 Host 所有权

Host 拥有文本和凭据。`ReadingTarget` 指明一个 Session 和一条消息；Host 在已存储的 Session 日志中找到这条助手消息，把它的 Markdown 转成朗读文本并切段。Client 收到的是区间和 base64 PCM 的 `AudioFrame`，从不收到文本；Host 只接受属于所指消息的段的区间。控制器在两次调用之间不保存朗读状态。

浏览器拥有播放和控速。每次朗读使用一个 `AudioContext` 首尾相接地播放各帧，它的时钟决定下一段何时到期。同一时间只有一次朗读；离开 Session 会停止它的朗读。朗读不追加 Session 事件，也不改变模型输入。

`ReadAloudStatus` 报告现在能否开始朗读。只有状态为 `ready`，并且当前 Peer 可以调用朗读方法时，才提供消息按钮；这些方法把所指的 Session 声明为访问资源。

## 失败

某一段失败时，已收到的音频播完后朗读结束。Client 在弹出提示中显示失败类别。对于可能恢复的失败，再次点击同一条回复会从失败的那一段继续，所以已经听过的音频不会被再次合成。不再是该消息的段的区间，或 Provider 不再提供的音色（例如配置变化之后），会以 `readAloud/stale-plan` 被拒绝。

## 设计依据

[分段控速决策](../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.zh.md)解释为什么按段控速、为什么由浏览器驱动，以及为什么由 Host 自己转换 Markdown。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxreadaloud--readaloudcontroller"></a>

### `ctx.readAloud` — `ReadAloudController`

Read-aloud calls never activate, read from, or submit to an Agent, and append no Session event.

```ts cordis-catalog
/**
 * Follow whether a reading can start and which voices exist, so the Client offers the action only while it can and
 * shows the saved voice.
 * @param signal - Client observation lifetime.
 * @returns the current status, then each change of it.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<ReadAloudStatus>

/**
 * Save the voice that readings started afterwards use.
 * @param selection - one of the voices `follow()` reports.
 */
@Remote async configure(selection: VoiceSelection): Promise<void>

/**
 * Locate one finalized assistant message and cut its readable text into segments.
 * @param target - Session and message to read.
 * @param signal - Client cancellation.
 * @returns the message's log position, its segments, the voice, and the pacing and audio facts; no text leaves the Host.
 */
@Remote({ resources: { session: target => target.sessionId } }) async plan(target: ReadingTarget, signal: AbortSignal): Promise<ReadingPlan>

/**
 * Synthesize one planned segment in the plan's voice. The range must be a segment of the message under the current
 * configuration, so a Client cannot have other text spoken.
 * @param request - message position, one segment of its plan, and the plan's voice.
 * @param signal - Client cancellation; it ends the provider request.
 * @returns frames of whole PCM samples in playback order.
 */
@Remote({ mode: 'stream', resources: { session: request => request.sessionId } }) async *synthesize(request: SegmentRequest, signal: AbortSignal): AsyncIterable<AudioFrame>

/**
 * Speak the Host's sample sentence in one voice, so a listener can choose between voices.
 * @param request - voice to hear and the language of the sentence.
 * @param signal - Client cancellation; it ends the provider request.
 * @returns frames of whole PCM samples in playback order, at `SynthesisFacts.sampleRate`.
 */
@Remote({ mode: 'stream' }) async *sample(request: SampleRequest, signal: AbortSignal): AsyncIterable<AudioFrame>
```

Source: [`packages/experimental/read-aloud/src/index.ts`](../../packages/experimental/read-aloud/src/index.ts)

<a id="ctxtexttospeech--texttospeech"></a>

### `ctx.textToSpeech` — `TextToSpeech`

Registry shared by all synthesis consumers in one Host composition.

```ts cordis-catalog
/**
 * Register one synthesizer; a duplicate id fails without replacing the original.
 * @param provider - synthesizer owned by the contributing fiber.
 * @returns idempotent disposer which rejects later pulls, cancels, and joins provider calls in flight.
 */
register(provider: SynthesisProvider): () => Promise<void>

/**
 * Read provider availability, the configured selection, and the voice preference together.
 * @returns one detached complete observation.
 */
snapshot(): SynthesisSnapshot

/**
 * Persist the voice preference into this plugin's profile entry. The configured provider must be registered and
 * offer the voice.
 * @param patch - voice that later syntheses use when they name none.
 * @returns after the profile write and the live update it applies.
 */
async configure(patch: SynthesisSelectionPatch): Promise<void>

/**
 * Observe complete snapshots; an observer that falls behind receives only the latest one.
 * @param caller - observer lifetime.
 * @returns an initial snapshot followed by one per change, ending when the observer or the service stops.
 */
async *follow(caller: AbortSignal): AsyncIterable<SynthesisSnapshot>

/**
 * Apply the configured provider and the voice preference, and capture both. A missing provider, a text over the
 * provider's limit, and a named voice the provider does not offer fail explicitly.
 * @param request - complete text to speak and optionally its voice.
 * @returns provider-pinned input for synthesize().
 */
resolve(request: SynthesisRequest): SynthesisSpec

/**
 * Speak through exactly the resolved provider; no fallback sends text elsewhere. A stream nobody pulls holds no
 * provider call: withdrawal aborts the provider's signal and joins only calls in flight.
 * @param spec - resolved input; a withdrawn or replaced registration is rejected.
 * @param signal - caller cancellation.
 * @returns the provider's audio; pulls after cancellation or withdrawal reject.
 */
synthesize(spec: SynthesisSpec, signal: AbortSignal): AsyncIterable<Uint8Array>
```

Source: [`packages/experimental/text-to-speech/src/index.ts`](../../packages/experimental/text-to-speech/src/index.ts)
<!-- END GENERATED cordis-surface -->
