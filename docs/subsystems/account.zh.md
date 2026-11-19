# DeepSeek 账号

[English](account.md) | 中文

[dsh-deepseek-account](../../packages/account/deepseek-account) 的账号服务通过系统浏览器完成登录，把得到的授权作为[凭据 seam](credentials.zh.md) 的一条凭据记录保存，并向 Host 消费方释放按请求的账号凭据。消费方只说明一次请求的目标地址并取得该请求所携带的请求头；它们既不读取已存 token，也不选择其请求头，也不决定哪个来源可以接收它。客户端通过不携带凭据的 `account` Remote 命名空间观察账号状态。

来源：[`packages/account/deepseek-account/src/index.ts`](../../packages/account/deepseek-account/src/index.ts)

## 请求凭据

`resolveRequestCredential(url)` 仅限 Host。未登录、凭据删除进行中，以及目标地址不在配置的 `inferenceOrigin` 之内时，它回答 `undefined`；否则返回一个 `AccountRequestCredential`：`headers` 以 `x-dsh-auth-token` 携带 token，`reject()` 仅在已存授权仍与该 token 一致时删除它，并隔离存储失败，使调用方报告的是目标地址的拒绝。其 `revoked` 信号在账号退出该 token 所属的登录时中止，无论退登由用户发起还是由拒绝触发，且在 `deepseek-account/signed-out` 的监听器返回之后；账号模型路由和 DeepSeek Web 提供方让携带该 token 的每个模型、Files、Search 与 Fetch 请求受它约束，因此即使发出请求的插件已卸载，退登仍会结束这些请求。消费方不直接调用它：[`ctx.deepseekAuth`](../../packages/account/deepseek-auth/README.zh.md) 代 `deepseek-account` 模型路由和 DeepSeek Web 提供方索取这份凭据，目标地址位于该路由基础地址的 origin 之下；没有该路由时，位于 `DEEPSEEK_BASE_URL` 的 origin 之下。`reject()` 在被调用时挂载的账号服务上执行，因此请求与目的地应答之间发生的重载仍会移除授权；没有挂载的服务时，授权留给下一个挂载的服务处理。已被替换的账号服务释放的凭据，其信号保持未中止，因为替换后的服务只撤回自己释放的凭据。

按账号计费的模型路由在 `ctx.effect()` 内用 `registerRunningTaskReport(report)` 注册运行中任务报告；只要有报告回答 true，`hasRunningAccountTasks()` 就回答 true，使退登确认能够提醒退登将打断的工作。`deepseek-account/signed-out` 之后取消这些工作由路由插件负责；比插件存活更久的请求通过其凭据的 `revoked` 信号结束，插件为该请求提供的失败回调随后取消这些工作。

## 内嵌 Platform 凭证

PlatformSession 是 getPlatformSession 返回的仅限 Host 快照：origin 指定所配置的 Platform 签发来源，token 包含其已存账号凭证。userId 复制最近一次成功 getProfile 得到的稳定账号 ID；尚无一次成功读取或资料不含 ID 时为 null。快照复用该 ID，不自行发起资料请求，因此 ID 未知时只会让 userId 为 null，而不会延迟调用方；资料读取首次取得稳定 ID 或该 ID 变化时仅通知使用 `watch(signal, true)` 的 Host 订阅者，供标识使用方重新读取快照。使用方以 origin 和 userId 作为持久化浏览器存储的键，为 null 时退回临时存储。账号已退登或读取凭证期间凭证变化时不返回快照；签发来源不匹配时失败。原生使用方负责在凭证变化时使文档失效。账号 Remote API、AccountView 和 AccountDetails 均不包含此快照。

AccountDetails.balance 将充值钱包投影为 value、赠送钱包投影为 bonusWallets，分别保留币种和十进制余额字符串。查询失败不包含钱包数组。

通知查询返回 AccountNotificationBatch，包含服务端的 nextPollAfterSeconds 和按服务端顺序排列的通知。每条 AccountNotification 携带不透明 id、createdAt、可为 null 的 displayUntil、本地化的 title 与 body、有序 actions 以及可选的 JSON data，绝不包含凭证。getNotificationContent 按 id 读取一条通知，包括已消费的通知；reportNotificationEvent 为其上报 displayed、cta_clicked 或 dismissed。通知操作通过 x-client-locale 传递发起界面的语言，不使用语言查询参数。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdeepseekaccount--deepseekaccount"></a>

### `ctx.deepseekAccount` — `DeepSeekAccount`

Account login, credentials, and client-safe Remote operations.

```ts cordis-catalog
/**
 * Read stored-account presence and the latest login attempt.
 * @returns a snapshot without credentials or PKCE secrets.
 */
@Remote async getState(): Promise<AccountView>

/**
 * Query Platform profile independently of wallet balances.
 * A ready result whose stable profile ID first becomes available or changes notifies identity-enabled watch
 * consumers, so they re-read getPlatformSession; repeated IDs stay silent.
 * @param client - identity of the requesting UI for this call.
 * @returns profile outcome, or null if signed out or the grant changed during the query.
 */
@Remote async getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null>

/**
 * Query Platform recharge and bonus wallet balances independently of profile data.
 * @param client - identity of the requesting UI for this call.
 * @returns balance outcome, or null if signed out or the grant changed during the query.
 */
@Remote getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null>

/**
 * Query unconsumed account notifications in server order without reading profile data.
 * @param client - identity of the requesting UI for this call; its language selects the server-authored message.
 * @returns notifications with their next query delay, or null if signed out or the grant changed during the query.
 */
@Remote async getNotifications(client: AccountClientMetadata): Promise<AccountNotificationBatch | null>

/**
 * Query localized content of a notification, including one already consumed.
 * @param id - notification whose content is requested.
 * @param client - identity of the requesting UI; its language selects the localized content.
 * @returns content without changing consumption, or null if signed out or the grant changed.
 */
@Remote async getNotificationContent(id: AccountNotificationId, client: AccountClientMetadata): Promise<AccountNotification | null>

/**
 * Report a notification interaction; the backend decides consumption.
 * @param id - notification the user interacted with.
 * @param event - displayed frame, non-dismiss action click, or explicit dismissal.
 * @param client - identity of the requesting UI for this call.
 * @returns true once the server accepts the event; false if signed out or credentials changed during the call.
 */
@Remote async reportNotificationEvent(id: AccountNotificationId, event: AccountNotificationEvent, client: AccountClientMetadata): Promise<boolean>

/**
 * Read existing login identity without creating a device or returning credentials.
 * @returns optional device/account identifiers and the provider's OS version string.
 */
async getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }>

/**
 * Read credentials for the configured embedded-page origin, bound to their account environment, and
 * pair them with the account ID from the last successful profile read; no profile request is made.
 * @returns a Host-only snapshot, or null while signed out or when the credential changed during the read.
 */
async getPlatformSession(): Promise<PlatformSession | null>

/**
 * Release the account credential for one request to `url` as the request
 * carries it, together with its invalidation, which runs on the account
 * service mounted when it is called, and the signal this service aborts
 * when it signs out of that credential. Host-only.
 * @param url - actual request destination or API base URL.
 * @returns the request credential, or undefined for other origins or a signed-out account.
 */
async resolveRequestCredential(url: string): Promise<AccountRequestCredential | undefined>

/**
 * Join an active attempt or start browser authorization.
 * @param client - identity of the requesting UI; a new attempt captures it, and joining retains the original attempt's identity.
 * @param callbackOrigin - browser-accessible loopback HTTP origin, including any SSH local port.
 * @param loginSource - initiating UI, used to return from a failed exchange.
 * @returns the initial snapshot without waiting for browser approval.
 */
@Remote async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView>

/**
 * Cancel only the named attempt; committing attempts settle before returning.
 * @param attemptId - attempt identity from this Host.
 * @returns state after cancellation or an already-started commit.
 */
@Remote async cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView>

/**
 * Remove the local grant while retaining API keys; the provider revokes it in the background.
 * @param client - identity of the requesting UI, captured for the background revocation retries.
 * @returns the signed-out state after local removal; remote failures never restore the grant.
 */
@Remote signOut(client: AccountClientMetadata): Promise<AccountView>

/**
 * Register a report of running work that signing out would interrupt. The
 * plugin billing the account to a model route registers one from within
 * `ctx.effect()`; without any report nothing is known to be running.
 * @param report - answers whether such work is running now.
 * @returns the disposer removing the report.
 */
registerRunningTaskReport(report: () => boolean): () => void

/**
 * Inspect running work before sign-out.
 * @returns whether a registered report says a running task uses the account; false without reports.
 */
@Remote hasRunningAccountTasks(): boolean

/**
 * Subscribe to live credential expiry without replay.
 * @param signal - subscription lifetime; provider disposal also ends it.
 * @returns expiry notifications emitted during the subscription.
 */
@Remote({ mode: 'stream' }) async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'>

/**
 * Subscribe to ordered updates including a complete initial snapshot.
 * @param signal - subscription lifetime; ending it never cancels login.
 * @param includeIdentityChanges - also notify when cached Platform identity changes; defaults to false.
 * @returns complete state with snapshot or credentials-changed event type; credential changes take priority when updates coalesce.
 */
watch(signal: AbortSignal, includeIdentityChanges: boolean = false): AsyncIterable<AccountUpdate>

/**
 * Stream account state without the Host-only identity subscription option.
 * @param signal - subscription lifetime.
 * @returns initial state, login progress, and credential-change updates.
 */
@Remote({ name: 'watch', mode: 'stream' }) watchState(signal: AbortSignal): AsyncIterable<AccountUpdate>
```

Source: [`packages/account/deepseek-account/src/index.ts`](../../packages/account/deepseek-account/src/index.ts)

<a id="ctxdeepseekauth--deepseekauth"></a>

### `ctx.deepseekAuth` — `DeepSeekAuth`

`ctx.deepseekAuth`: the two DeepSeek credential kinds behind one request-authorization operation.

```ts cordis-catalog
/**
 * Connect the deployment a model route plugin's settings name for one kind. Call it from within `ctx.effect()`.
 * @param kind - the kind the plugin's route bills.
 * @param route - provider route the plugin registers; {@link routeKind} answers `kind` for it while connected.
 * @param connection - reads the plugin's current settings; a throw marks the kind unresolved for that operation.
 * @returns the disposer removing the connection.
 * @throws {DeepSeekAuthError} code `DUPLICATE_CONNECTION` when the kind is already connected.
 */
connect(kind: DeepSeekAuthKind, route: string, connection: () => DeepSeekAuthConnection): () => void

/**
 * The kind that bills a conversation on one model route.
 * @param route - provider route of a model request; undefined names none.
 * @returns the kind connected under that route, or undefined for a route no plugin connected.
 */
routeKind(route: string | undefined): DeepSeekAuthKind | undefined

/**
 * The kinds one request can authenticate with, in the order its billing tries them, each bound to its destination.
 * Nothing is read from a credential store.
 * @param request - the request.
 * @returns candidates and unresolved kinds, first preferred; empty when the destination accepts no kind the
 *   billing allows or no allowed kind serves an absolute destination.
 */
candidates(request: DeepSeekAuthRequest): (DeepSeekAuthCandidate | DeepSeekAuthUnresolved)[]

/**
 * Release the credential of the first candidate that has one. A later candidate is not read once an earlier one
 * has a credential, fails to read, or does not resolve.
 * @param request - the request.
 * @param signal - cancellation for the lookups.
 * @returns the authorization, or undefined when no candidate has a credential.
 * @throws {DeepSeekAuthError} code `UNRESOLVED_CONNECTION` at an unresolved kind, `INVALID_CREDENTIAL` for an
 *   unusable API key; store failures propagate.
 */
async authorize(request: DeepSeekAuthRequest, signal?: AbortSignal): Promise<DeepSeekAuthorization | undefined>
```

Source: [`packages/account/deepseek-auth/src/index.ts`](../../packages/account/deepseek-auth/src/index.ts)

<a id="deepseek-account-events"></a>

### `deepseek-account/*` events

<a id="deepseek-accountmodel-sign-in-required--emit"></a>

#### `deepseek-account/model-sign-in-required` — emit

An account model request requires the user to sign in.

```ts cordis-catalog
/** An account model request requires the user to sign in.
 * @mode emit
 */
'deepseek-account/model-sign-in-required'(): void
```

Source: [`packages/account/deepseek-account/src/types.ts`](../../packages/account/deepseek-account/src/types.ts)

<a id="deepseek-accountsession-expired--emit"></a>

#### `deepseek-account/session-expired` — emit

Server rejection removed the current account credential; this notification is not replayed.

```ts cordis-catalog
/** Server rejection removed the current account credential; this notification is not replayed.
 * @mode emit
 */
'deepseek-account/session-expired'(): void
```

Source: [`packages/account/deepseek-account/src/types.ts`](../../packages/account/deepseek-account/src/types.ts)

<a id="deepseek-accountsigned-out--emit"></a>

#### `deepseek-account/signed-out` — emit

Local grant removal has completed. After the listeners return, the `revoked` signal of that grant's request credentials aborts.

```ts cordis-catalog
/** Local grant removal has completed. After the listeners return, the `revoked` signal of that grant's request credentials aborts.
 * @mode emit
 */
'deepseek-account/signed-out'(): void
```

Source: [`packages/account/deepseek-account/src/index.ts`](../../packages/account/deepseek-account/src/index.ts)
<!-- END GENERATED cordis-surface -->

账号服务定义提供 getState、getProfile、getBalance、getNotifications、getNotificationContent、reportNotificationEvent、startSignIn、cancelSignIn、signOut、watch 及仅限 Host 的 resolveRequestCredential、registerRunningTaskReport 和 getPlatformSession。平台提供者使用 AuthorizationFlow 和私有 GrantRecord 实现这些操作。AccountView 区分本地存在与服务器验证；尝试 ID 将取消绑定到单次本地流程。AccountUpdate 的 state 携带完整 AccountView，type 为 snapshot 时表示首次或进度更新，为 credentials-changed 时表示凭据写入或删除。待发送的凭据变化优先于进度更新。参见[账号包](../../packages/account/deepseek-account/README.zh.md)。

`AccountClientMetadata` 携带调用方 `DSH_CLIENT_VERSION` 提供的 `version`、当前界面 `locale`，以及操作发起时采样的 `timezoneOffsetSeconds`。偏移为本地时间减 UTC 的秒数：UTC+8 对应 `28800`。其中不含凭证。登录申请在兑换及取消期间保留发起时的元数据；退出操作为撤销重试保留其元数据。
