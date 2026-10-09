# 文本翻译

[English](translation.md) | 中文

实验性 [translator](../../packages/experimental/translator/README.zh.md) 通过免登录浏览器端点或显式选择的付费原生 Flash 路由翻译文本。消费者负责展示、调度及 Session 激活；绑定 Session 的请求通过已激活 Session 的写入器保留可复用结果。

## 请求与结果

`TranslationProvider` 选择 `bing`、`google`、`deepseek-account` 或 `deepseek-official`。`TranslationRequest` 提供 `text`、`targetLanguage` 及可选的 `sourceLanguage`、`provider` 与带品牌类型的 `sessionId`。`resolve()` 将显式路由写入 `TranslationSpec`：配置的默认 Provider 为 Bing，省略源语言时自动检测。常见中文 locale 标签映射为所选 Provider 的语言代码。`translate()` 返回所选 Provider 翻译后的纯文本。

服务公开配置的 `maxTextChars`，单位为 UTF-16 code unit。消费者先拆分超长输入，再请求翻译。每次调用限制响应字节数，并将响应体读取计入超时。调用者取消和服务卸载都会中止已接收的请求；卸载等待这些请求完成。

## 失败与数据处理

`TranslationError` 的 `TranslationErrorCode` 区分文本超限、HTTP 失败、无效响应、响应超限、服务自身超时与请求失败。`TRANSLATION_SESSION_REQUIRED` 拒绝缺失的持久化后端或 Session，`TRANSLATION_SESSION_INACTIVE` 在调用 Provider 前拒绝未激活且缓存未命中的 Session，`TRANSLATION_STORAGE_ERROR` 拒绝无效保存记录或持久化失败。Provider 错误信息省略提交的文本与响应体。失败时不选择其他 Provider。响应作为外部 JSON 校验，重定向被拒绝。

`TRANSLATION_UNAVAILABLE` 拒绝缺失的活跃内置所有者或已注册路由、未配置的凭据、目录中不存在精确的 `deepseek-flash`、派发前所有者／模型列表／官方凭据引用变化、提供方卸载，以及准备后的调用推理强度不是 `off` 的情况。原生 `finish` 的原因为 `error` 时映射为 `TRANSLATION_REQUEST_FAILED`；缺失 finish 或其他非 `stop` 原因映射为 `TRANSLATION_INVALID_RESPONSE`。

Google 在 form POST 请求体中接收原文，Bing 在 JSON POST 请求体中接收原文。两者都是远端服务。免登录端点不保证开发者 API 的可用性或免费额度。区域连通性须在用户网络上验证。

## 持久化翻译

绑定 Session 的调用对所有 Provider 使用 `plugin:translator/request` 与 `plugin:translator/result`。请求保留精确原文、语言标签、所选 Provider 和翻译规则标识，成功结果引用请求序号。可选请求 metadata 保存 Provider 专有细节，不改变记录类型。translator 在外部派发前完成请求检查点，在返回前完成结果检查点。只读缓存查找先于 Provider 调用，且不要求 Session 已激活；失败或未完成尝试不提供可复用译文。新记录使用已激活 Session 的现有写入器。translator 不打开写句柄，也不激活 Session。翻译记录保留原始事件与模型输入。不指定 Session 的匿名调用保持无状态；付费路由要求 Session。未来格式迁移对实验性记录的保留为尽力而为。

付费缓存未命中时要求内置账号或官方 API 所有者处于活动状态、凭据已配置，且目录包含 ID 恰好为 `deepseek-flash` 的模型；名称和版本标签不参与匹配，pi-ai 路由被排除。每次未命中准备一次关闭思考的独立纯文本查询。精确配置、系统指令和唯一原文片段保存在同一请求记录的可选 `metadata.modelRequest` 中。读取保存结果先于此项准入，因此凭据缺失不会使既有译文失效。原生请求扩展不接收主 Session 身份，不能上传其完整日志。

## 思考内容展示

[可选 Bundle](../../packages/experimental/cot-translation-bundle/README.zh.md) 将 translator 与 [GUI 消费者](../../packages/experimental/client-ui-cot-translation/README.zh.md) 组合。其 `cotTranslation` Remote 为经过身份验证的浏览器调用提供服务。Session 未激活且没有已保存结果时，Host 等待 Session controller 的正常激活，再重试一次。激活保留正常的 preset 钩子、恢复标记和中断轮次修复；取消会结束调用者的等待并阻止随后调用翻译，不取消共享激活。Bundle 设置选择翻译服务及目标语言；`auto` 跟随当前界面语言。

`CotTranslationPreferences` 包含已接受的翻译服务和目标语言。`CotTranslationSnapshot` 将这些偏好与 translator 当前的 `maxTextChars` 及可用服务 ID 一起返回。浏览器在注册翻译控件前读取此 Host 快照，本地设置存储不可用时也如此。接受的设置更新及重新连接会刷新这两项值；请求长度限制变化时，展开内容的请求被取消并重新分片。

GUI 向 Session 作用域的 `conversation.chat.reasoning.body` single Slot 注册，替换 Chat 的默认条目。两个条目均复用官方 `conversation.chat.reasoning.content` Factory；翻译包装选择显示文本，自行维护工具栏和视图状态，传入自己的本地化 labels，不重复实现 Markdown 渲染。启用后，GUI 只在展开后翻译完整段落和流式长段落中达到请求长度的前缀，并从当前 Session 恢复已完成结果；本地缓存只优化当前展开区域。未完成的末尾片段保留原文。原文始终可访问。关闭展开内容、切换 Provider 或语言、卸载插件都会取消未完成调用并忽略迟到的结果。Provider 失败时保留原文，必须显式重试；译文从不替换原始 Session 事件或模型输入。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcottranslation--cottranslationcontroller"></a>

### `ctx.cotTranslation` — `CotTranslationController`

Optional reasoning translation delegates Session-bound storage to the translator.

```ts cordis-catalog
/**
 * Read accepted translation preferences and the current request limit without sending text.
 * @param signal - browser query cancellation or Remote contribution withdrawal.
 * @returns authoritative preferences, eligible routes, and maximum UTF-16 text length per request.
 */
@Remote async limits(signal: AbortSignal): Promise<CotTranslationSnapshot>

/**
 * Translate one displayed fragment through the reader's selected provider.
 * @param request - original text and Session identity supplied by the Client; provider and explicit
 * target language match accepted preferences, while auto uses the browser locale.
 * @param signal - browser cancellation or Remote contribution withdrawal.
 * @returns translated text; an uncached inactive Session joins ordinary GUI activation before retry.
 * Failures omit the source and provider response. Cancellation stops this caller's wait, not shared activation.
 */
@Remote async translate(request: TranslationRequest, signal: AbortSignal): Promise<string>
```

Source: [`packages/experimental/client-ui-cot-translation/src/index.ts`](../../packages/experimental/client-ui-cot-translation/src/index.ts)

<a id="ctxtranslator--translator"></a>

### `ctx.translator` — `Translator`

One Host service with explicit routing, cancellation and quiescent unload.

```ts cordis-catalog
/**
 * Inspect eligible native routes without inference; saved results remain readable for unavailable routes.
 * @param signal - optional caller cancellation, combined with service disposal.
 * @returns anonymous choices followed by eligible explicitly selected paid routes.
 */
async availableProviders(signal?: AbortSignal): Promise<readonly TranslationProvider[]>

/**
 * Resolve provider and source-language defaults without sending text.
 * @param request - consumer text, destination and optional routing choices.
 * @returns a complete specification; exceeding `maxTextChars` throws `TRANSLATION_TEXT_LIMIT`.
 */
resolve(request: TranslationRequest): TranslationSpec

/**
 * Translate one resolved specification; the selected provider receives its text.
 * @param spec - complete routing and language choices from `resolve()`.
 * @param signal - optional caller cancellation, combined with service disposal.
 * @returns translated plain text, durably retained before return when a Session is supplied.
 * An uncached supplied Session must be active; otherwise rejects with `TRANSLATION_SESSION_INACTIVE` before dispatch.
 * Rejects provider/storage/limit failures and preserves cancellation reasons.
 */
async translate(spec: TranslationSpec, signal?: AbortSignal): Promise<string>
```

Source: [`packages/experimental/translator/src/index.ts`](../../packages/experimental/translator/src/index.ts)
<!-- END GENERATED cordis-surface -->
