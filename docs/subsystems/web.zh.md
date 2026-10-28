# Web 访问

[English](web.md) | 中文

Web 访问 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)，在同一个 `ctx.web` 服务上横跨**两项操作**（search 与 fetch），并拆分到多个包：Service Definition（[dsh-web](../../packages/web/web)，`ctx.web` + 提供方注册表）、Service Provider（[dsh-web-search-exa](../../packages/web/web-search-exa)、[dsh-web-search-perplexity](../../packages/web/web-search-perplexity)、[dsh-web-search-deepseek](../../packages/web/web-search-deepseek)、[dsh-web-deepseek-api](../../packages/web/web-deepseek-api)、[dsh-web-fetch-http](../../packages/web/web-fetch-http)）与 Consumer（[dsh-tool-web](../../packages/web/tool-web)，即 `web_search`/`web_fetch` 工具 schema）。Web 是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.zh.md) 中。更换 search 提供方不会改变模型提交查询的方式，更换 fetch 提供方也不会改变模型请求 URL 的方式。

源码：[`packages/web/web/src/types.ts`](../../packages/web/web/src/types.ts)

## 为什么一项能力包含两项操作

搜索与抓取既不共享请求 schema，也不共享业务逻辑，但它们被有意设计为同一个 `ctx.web` 中间层：一个提供方选择策略的所有者、一套中止与错误词汇，以及一个面向产品的「此 harness 如何访问 Web」配置界面。代价是服务上并行的 `searchX`／`fetchX` 方法对；这种并行是有意为之，而不是遗漏了可抽取的共性。提供方注册的是**能力**（`WebSearchProvider` 或 `WebFetchProvider`），而非工具；面向模型的名称、schema、提示词引导与展示全部集中在唯一的消费方 `dsh-tool-web` 中。

## 搜索请求与结果

每个 seam 请求只携带一个 `query`。消费方 `dsh-tool-web` 接受必填的 `queries` 数组，并把它扇出为多个独立 seam 请求；单元素数组执行一次搜索。`maxResults` 是消费方自有的上限（`dsh-tool-web` 的 `searchMaxResults` 配置，默认 `8`），通过 seam 传递并在返回时强制执行——如果提供方返回超量，seam 截断 `sources[]` 并设置 `truncated`。

```ts type-equiv
/**
 * What one search-capable backend is asked to search. Each request carries one
 * query; a consumer may issue several requests. `maxResults` is a
 * `dsh-tool-web`-layer bound passed through unchanged and enforced on the way
 * back by the seam (see {@link WebSearchResult}).
 */
interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it. A provider whose API supports a
   * result-count control (Exa's `numResults`) should apply it at the request
   * layer as a cost/latency optimization; the seam enforces the bound
   * regardless.
   */
  readonly maxResults?: number
}
```

```ts type-equiv
/**
 * Normalized search outcome. `content` is optional provider-generated answer
 * text or summary (Exa and DeepSeek return none; Perplexity returns a
 * generated answer).
 * `sources[]` is the portable citation shape. `truncated` is set by the seam
 * when it cut `sources[]` down to `maxResults`.
 */
interface WebSearchResult {
  /** Optional provider-generated answer text, search context, or summary. */
  readonly content?: string
  /** Citeable sources, already truncated to the request's `maxResults`. */
  readonly sources: readonly WebSearchSource[]
  /** True when the seam dropped sources to honor `maxResults`. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * One citeable source. A source always has a URL; `title`, `snippet`, `summary`,
 * and `publishedAt` are optional because not every provider returns them — forcing
 * adapters to invent them would make the seam lie (Perplexity citations may be
 * URL-only). `dsh-tool-web` renders `title ?? hostname(url)` for display.
 */
interface WebSearchSource {
  readonly url: string
  readonly title?: string
  /** Short excerpt suited to display. */
  readonly snippet?: string
  /** Longer excerpt suited to model reading; consumers bound its length. */
  readonly summary?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string. */
  readonly publishedAt?: string
}
```

## 抓取请求与结果

```ts type-equiv
/**
 * What one fetch-capable backend is asked to retrieve. The request deliberately
 * omits timeout, format, prompt, and extraction controls: cancellation is a
 * direct execution argument, while presentation and higher-level LLM concerns
 * belong outside safe retrieval.
 */
interface WebFetchRequest {
  readonly url: string
}
```

HTTP 状态码是被抓取资源状态的一部分，不自动视为失败：即使一次成功的网络抓取收到 `404` 或 `500` 响应，也仍会产出一个 `WebFetchResult`，其中包含状态码和长度受限的已解码正文。`url` 是经过允许的重定向后的最终 URL。`WebError` 仅用于无法安全获取或表示资源的情况。

```ts type-equiv
/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error: the status code is part of the fetched resource
 * state. {@link WebError} is reserved for failures to safely retrieve or
 * represent the resource.
 */
interface WebFetchResult {
  /** The final URL after allowed redirects (the request URL is in the request). */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: WebFetchBody
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * The decoded body of a fetched resource. A CLOSED discriminated union owned by
 * `dsh-web`: the provider decodes the kind and `dsh-tool-web` renders it, so a
 * new kind is a coordinated change across known packages, not a plugin
 * extension. Consumers `switch` on `kind` ending in `default: assertNever(...)`
 * so adding a kind breaks compilation at every consumer until handled. Each arm
 * stays its own object literal even where fields coincide, so an arm can gain
 * fields the others lack.
 */
type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
```

## 提供方可用性

提供方的 `available(): boolean` 是一个廉价的本地检查（凭证是否存在、配置是否可解析），**禁止发起网络调用**。它是执行时选择提供方的输入，而不是健康检查系统：`search()`／`fetch()` 会读取它来选择可用的提供方。选择失败时，调用方会收到可据以分支处理的结构化 `WebError`；其错误代码和消息会说明缺失的 id 或存在歧义的候选集。

搜索或抓取提供方还可以实现 `ready(llmProvider): Promise<boolean>`，这是只检查配置、禁止发起网络调用的判断：它回答为该对话路由上的模型请求发起的操作是否有可发送的凭据。`searchReady(llmProvider?)` 与 `fetchReady(llmProvider?)` 只询问 `search()` 或 `fetch()` 会选中的提供方，把没有 `ready()` 的提供方视为就绪，并在选择失败时回答 true，因为对应操作会把该失败报告为 `WebError`。就绪判断不是选择输入；`dsh-tool-web` 把它作为 `web_search` 与 `web_fetch` 的激活条件，因此路由回答 false 的模型步骤既不声明也不派发该工具。

选择从不依赖注册顺序、配置顺序或 HMR（热模块替换）顺序：一项能力要么有显式的提供方 id（配置 `searchProvider`／`fetchProvider`，或填充同一字段的对应环境变量），要么在恰好只有一个可用提供方注册时自动选择；如果存在多个可用提供方却未配置 id，则抛出 `WEB_PROVIDER_AMBIGUOUS`，而不会选用最先注册的提供方。每次操作在执行时读取配置的 id，因此保存的设置变更无需重新挂载 `ctx.web` 即对下一次搜索或抓取生效。

## 抓取网络策略

已交付的 Cordis、Code 与 Standard preset 会在所有 sandbox 和审批模式下暴露 `web_fetch`，无需逐次确认。文件 sandbox preset 不管辖 Web 网络访问。需要确认步骤的部署必须添加 `tools/pre-execute` 策略或禁用抓取。

HTTP 提供方不限制目的地址：`web_fetch` 会像访问其他主机一样访问 loopback、内网与云元数据主机，模型也可以把数据发送到它能访问的任何 URL。跨源重定向需要新的工具调用。需要阻止模型访问私有目的地址的部署必须使用网络隔离、`tools/pre-execute` 策略，或不挂载抓取工具。

## 错误

`WebError extends HarnessError`（[core.md](core.zh.md) 错误分类体系），带有 `code: string`（开放式，与其他 seam 的错误一致——`LlmError`、`SubagentError`），而非封闭联合类型：提供方可以在不修改 `dsh-web` 的情况下抛出自己的错误代码，消费方必须容忍未知错误代码。错误代码按所有者划分。共享的 `WebRuntime` 约定会抛出与 seam 无关的错误代码：`WEB_PROVIDER_UNAVAILABLE`、`WEB_PROVIDER_CONFIGURED_MISSING`、`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`、`WEB_PROVIDER_AMBIGUOUS`、`WEB_DUPLICATE_PROVIDER`（注册时的编程错误，类似 `LlmRuntime` 的 `DUPLICATE_ADAPTER`）、`WEB_ABORTED`，以及 `WEB_PROVIDER_ERROR`（提供方自身故障经 seam 暴露时使用的兜底代码，包括 DNS、连接被拒绝、TLS 等网络或传输故障）。抓取传输层错误代码由 `dsh-web-fetch-http` 实现拥有，不同的抓取后端无需抛出它们：`WEB_INVALID_URL`、`WEB_BLOCKED_URL`、`WEB_REDIRECT_BLOCKED`、`WEB_FETCH_TOO_LARGE`、`WEB_FETCH_TIMEOUT`、`WEB_UNSUPPORTED_CONTENT_TYPE`。

## 服务

`WebRuntime` 注册搜索与抓取提供方，以 `WEB_DUPLICATE_PROVIDER` 拒绝重复 id，并在执行时以结构化的选择错误解析提供方。本地抓取后端仅接受 HTTP(S)、拒绝凭证、经已安装的代理策略发送每个请求、对每一次同源重定向跳转重复 URL 校验、限制重定向次数、字节数、字符数和时间，并解码正文；展示由工具负责。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxweb--webruntime"></a>

### `ctx.web` — `WebRuntime`

The web access service. Registered as `ctx.web` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
 * if its id is already registered for search. Returns a disposer; disposed
 * with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerSearchProvider(provider: WebSearchProvider): () => void

/**
 * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
 * if its id is already registered for fetch. Returns a disposer; disposed
 * with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerFetchProvider(provider: WebFetchProvider): () => void

/**
 * Run one search through the selected provider. Resolves the provider at call
 * time with the selection rules above; throws {@link WebError} when the
 * capability cannot run. The seam enforces `request.maxResults` on the result:
 * if the provider over-returns, `sources[]` is truncated and `truncated` set.
 * @param request - the query and optional result limit.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the provider's results, capped to `request.maxResults`.
 */
async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>

/**
 * Whether the provider `search()` would select can authenticate a search made for a
 * model request on the `llmProvider` chat route. Asks only that provider's `ready()`;
 * one without `ready()` counts as ready. Makes no network calls. A selection failure
 * answers true, because `search()` reports that failure as a structured `WebError`.
 * @param llmProvider - the provider route id of the model request, when known.
 * @returns false only when the selected provider reports that it cannot authenticate.
 */
async searchReady(llmProvider?: string): Promise<boolean>

/**
 * Retrieve one URL through the selected provider. Resolves the provider at
 * call time with the selection rules above; throws {@link WebError} when the
 * capability cannot run. A non-2xx response is a result, not a throw.
 * @param request - the URL plus retrieval options.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the retrieval outcome; non-2xx responses resolve descriptively.
 */
async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>

/**
 * Whether the provider `fetch()` would select can authenticate a fetch made for a
 * model request on the `llmProvider` chat route. Asks only that provider's `ready()`;
 * one without `ready()` counts as ready. Makes no network calls. A selection failure
 * answers true, because `fetch()` reports that failure as a structured `WebError`.
 * @param llmProvider - the provider route id of the model request, when known.
 * @returns false only when the selected provider reports that it cannot authenticate.
 */
async fetchReady(llmProvider?: string): Promise<boolean>
```

Source: [`packages/web/web/src/index.ts`](../../packages/web/web/src/index.ts)
<!-- END GENERATED cordis-surface -->
