# 语音输入

[English](voice-input.md) | 中文

实验性语音识别包含三个角色：[服务定义](../../packages/experimental/speech-to-text/README.zh.md)路由具名 Provider，[SenseVoice Provider](../../packages/experimental/speech-to-text-sensevoice/README.zh.md)拥有本地推理，[Remote 消费者](../../packages/experimental/api-speech-to-text/README.zh.md)服务浏览器。[可选 Bundle](../../packages/experimental/voice-input-bundle/README.zh.md)将它们与麦克风 UI 组合。

## Provider 选择

`SpeechProviderId` 为注册标识添加类型品牌。`SpeechProviderInfo` 携带显示名称、支持的 `languages` 语言提示及 `host-local` 或 `cloud` 处理位置。`SpeechRequest` 包含 WAV 字节和可选的 Provider、语言选择；`resolve()` 生成捕获一个 Provider 实例的 `SpeechSpec`。缺失的 Provider 或不支持的语言会报错；替换或撤销会使已解析的任务失效。音频不会回退到其他 Provider。

`SpeechProvider.transcribe()` 接收完整的 `SpeechInput` 与 `AbortSignal`。`Transcript` 返回纯文本 `text`、`audioSeconds` 和 `inferenceSeconds`。Provider 响应取消，并在注销完成前结束其任务。本地 Provider 串行执行调用、限制队列，并独立于 Session 管理工作进程生命周期。

## 浏览器与 Host 所有权

浏览器拥有麦克风轨道与未发送的草稿。`TranscriptionRequest` 通过带认证的 Remote 发送规范 base64 PCM16 WAV。`SpeechCatalog` 公布可用 Provider、默认选择及录音字节和时长限制。API 在识别前校验这些进程输入。

输入门面在录音前捕获带版本的选区。`InputActions.insertText()` 仅在选区版本仍有效且提交状态允许编辑时，插入一次可撤销的纯文本编辑。插入被拒绝时，转写文字保留以供显式插入。切换 Session 或释放插件使迟到结果失效。识别本身不写入 Session 事件；普通用户提交拥有最终的模型可见文字。

## 准备与设置

`SpeechProviderInfo.downloadSources` 公布准备阶段的源。`SpeechPreparationOptions.downloadSource` 为单次任务选择一个源；省略时保留提供方策略。SenseVoice 校验公布的选项，固定使用手动指定的源而不回退，并拒绝在准备期间改源。UI 为当前卡片中的重试保留选择，但不会将其保存为识别偏好。

Host Provider 在页面和 Session 变化期间拥有同一个准备任务。Client 在输入框、安装引导弹窗、Bundle 详情之间共享一份 `follow()` 订阅。可选 `SpeechSetupEstimate` 元数据提供各 Provider 的资源预期，与实测进度分开。`SpeechPreparationStepKind` 标识有序资源操作；`SpeechPreparationStep` 记录各步骤状态与开始时间。完整 `SpeechPreparationState` 在取消或失败后保留这些步骤。折叠 UI 显示当前操作，展开后列出所有步骤，仅进行中步骤显示字节进度或等待时间。关闭观察者不会取消准备。已校验文件在重试及空闲进程回收后继续复用。

准备失败时可包含 `SpeechDownloadFailure`，提供文件、下载源、原因分类以及可选错误码或 HTTP 状态。Client 将恢复建议本地化；原始下载错误留在 Host。

麦克风占用模型选择器与发送按钮之间的 `conversation.input.activity`。点击开始录音并展开工具栏；停止后转写并插入草稿。活动栏保留编辑器与提交按钮，拥有局部反馈，并在卸载时释放展开状态。取消、Escape 或隐藏页面会丢弃录音。波形历史展示实测麦克风音量。Bundle 详情包含识别偏好、准备状态和进度。显式启用时通过 `plugins.bundle.activation` 引导缺少模型的用户前往安装；列表只显示 Bundle 描述和开关。

## 设计依据

[语音输入决策](../../.agents/notes/implemented/architecture/2026-09-16-experimental-voice-input.zh.md)解释临时音频、显式 Provider 选择和延迟准备本地运行时。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeechcontroller--speechcontroller"></a>

### `ctx.speechController` — `SpeechController`

Speech calls never activate or submit to an Agent.

```ts cordis-catalog
/**
 * Read provider choices without preparing a recognizer.
 * @returns available providers, resolved default, and recording limits.
 */
@Remote catalog(): SpeechCatalog

/**
 * Follow provider readiness independently of Session and preparation lifetimes.
 * @param signal - Client observation lifetime.
 * @returns initial and subsequent complete readiness snapshots.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<SpeechCatalog>

/**
 * Persist the user's recognition preferences.
 * @param patch - changed preference fields.
 * @returns after preferences are saved.
 */
@Remote configure(patch: SpeechSelectionPatch): Promise<void>

/**
 * Start or join one Host-owned preparation task.
 * @param providerId - selected recognizer.
 * @param options - task-local source selection validated by the provider.
 */
@Remote prepare(providerId: SpeechProviderId, options?: SpeechPreparationOptions): void

/**
 * Explicitly cancel resource preparation.
 * @param providerId - selected recognizer.
 * @returns after the preparation task settles.
 */
@Remote cancelPreparation(providerId: SpeechProviderId): Promise<void>

/**
 * Validate and transcribe one recording through the explicit provider selection.
 * @param request - canonical WAV encoded as base64, provider id and language hint.
 * @param signal - Client cancellation or Remote contribution disposal.
 * @returns final transcript without adding a Session event.
 */
@Remote async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcript>
```

Source: [`packages/experimental/api-speech-to-text/src/index.ts`](../../packages/experimental/api-speech-to-text/src/index.ts)

<a id="ctxspeechtotext--speechtotext"></a>

### `ctx.speechToText` — `SpeechToText`

Registry shared by all transcription consumers in one Host composition.

```ts cordis-catalog
/**
 * Register one recognizer; duplicate ids fail without replacing the original.
 * @param provider - recognizer owned by the contributing fiber.
 * @returns idempotent disposer which rejects admission, cancels, and joins accepted work.
 */
register(provider: SpeechProvider): () => Promise<void>

/**
 * Read the current recognizer roster.
 * @returns available provider facts in registration order.
 */
listProviders(): readonly SpeechProviderInfo[]

/**
 * Observe complete readiness snapshots; a slow reader coalesces intermediate progress.
 * @param caller - observer lifetime, independent of any preparation task.
 * @returns an initial snapshot followed by the latest provider states.
 */
async *follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot>

/**
 * Read provider readiness and current user preferences together.
 * @returns one detached complete observation.
 */
snapshot(): SpeechSnapshot

/**
 * Persist changed selection fields into this plugin's profile entry; the resulting language must be accepted by the selected provider.
 * @param patch - explicit provider or language changes.
 * @returns after the profile write and the live update it applies.
 */
async configure(patch: SpeechSelectionPatch): Promise<void>

/**
 * Start or join provider-owned preparation.
 * @param id - exact registered provider identity.
 * @param options - task-local source selection validated by the provider.
 */
prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void

/**
 * Explicitly cancel provider preparation without tying it to a browser connection.
 * @param id - exact registered provider identity.
 * @returns after the preparation task settles.
 */
async cancelPreparation(id: SpeechProviderId): Promise<void>

/**
 * Apply composition defaults and capture the selected provider. Missing providers and unsupported languages fail explicitly.
 * @param request - complete recording and optional selection.
 * @returns provider-pinned input for transcribe().
 */
resolve(request: SpeechRequest): SpeechSpec

/**
 * Execute exactly the resolved provider; no fallback sends audio elsewhere.
 * @param spec - resolved input; a withdrawn or replaced registration is rejected.
 * @param signal - caller cancellation.
 * @returns final transcript after provider settlement.
 */
async transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript>
```

Source: [`packages/experimental/speech-to-text/src/index.ts`](../../packages/experimental/speech-to-text/src/index.ts)
<!-- END GENERATED cordis-surface -->
