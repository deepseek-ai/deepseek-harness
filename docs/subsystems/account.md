# DeepSeek Account

English | [中文](account.zh.md)

The account service of [dsh-deepseek-account](../../packages/account/deepseek-account) signs the user in through the system browser, stores the resulting grant as a credential record of the [credential seam](credentials.md), and releases per-request account credentials to Host consumers. Consumers name the destination of one request and receive the headers that request carries; they never read the stored token, choose its header, or decide which origin may receive it. Clients observe account state through the `account` Remote namespace, which carries no credential.

Source: [`packages/account/deepseek-account/src/index.ts`](../../packages/account/deepseek-account/src/index.ts)

## Request credentials

`resolveRequestCredential(url)` is Host-only. It answers `undefined` while signed out, during credential removal, and for any destination outside the configured `inferenceOrigin`; otherwise it returns an `AccountRequestCredential` whose `headers` carry the token as `x-dsh-auth-token` and whose `reject()` removes the stored grant only while it still matches that token, containing storage failures so the caller reports the destination's rejection. Its `revoked` signal aborts when the account signs out of the sign-in that token belongs to, by the user or after a rejection, once the `deepseek-account/signed-out` listeners have returned; the account model route and the DeepSeek web providers run each model, Files, Search, and Fetch request that carries the token under it, so a sign-out ends those requests even after the plugin that sent them has unloaded. Consumers do not call it themselves: [`ctx.deepseekAuth`](../../packages/account/deepseek-auth/README.md) asks for the credential on behalf of the `deepseek-account` model route and the DeepSeek web providers, for a destination under the origin of that route's base URL or, without that route, of `DEEPSEEK_BASE_URL`. `reject()` runs on the account service mounted when it is called, so a reload between a request and the destination's answer still removes the grant; without a mounted service it leaves the grant for the next one to reject. A credential released by an account service that has since been replaced keeps an unaborted signal, because the replacement withdraws only the credentials it released.

Model routes that bill the account register a running-task report with `registerRunningTaskReport(report)` inside `ctx.effect()`; `hasRunningAccountTasks()` answers true while any report does, so the sign-out confirmation can warn about work the sign-out interrupts. The route plugin owns cancellation of that work after `deepseek-account/signed-out`; a request that outlives the plugin ends through its credential's `revoked` signal, and the plugin's failure callback for that request cancels the work.

## Embedded Platform credentials

PlatformSession is a Host-only snapshot from getPlatformSession: origin names the configured Platform issuer and token contains its stored account credential. userId repeats the stable account ID from the most recent successful getProfile, and is null until one succeeds or when that profile carries no ID. The snapshot reuses that ID without issuing a profile request of its own, so an unknown ID leaves userId null instead of delaying the caller; a profile read whose stable ID first becomes available or changes notifies only Host subscribers using `watch(signal, true)`, which lets identity consumers re-read the snapshot. Consumers key persistent browser storage by origin and userId and fall back to temporary storage for null. Signed-out accounts and credentials changed during the credential read return no snapshot; a mismatched issuer fails. Native consumers own document invalidation when credentials change. This snapshot is excluded from account Remote API, AccountView, and AccountDetails.

AccountDetails.balance projects recharge wallets in value and promotional wallets in bonusWallets, with independent currency and decimal balance strings. Failed queries contain no wallet arrays.

Notification queries return an AccountNotificationBatch with the server's nextPollAfterSeconds and its notifications in server order. Each AccountNotification carries an opaque id, createdAt, a nullable displayUntil, localized title and body, ordered actions, and optional JSON data, never credentials. getNotificationContent reads one notification by id, including consumed ones, and reportNotificationEvent reports displayed, cta_clicked, or dismissed for it. Notification operations use the initiating UI language through x-client-locale, without a language query parameter.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

The account Service Definition exposes getState, getProfile, getBalance, getNotifications, getNotificationContent, reportNotificationEvent, startSignIn, cancelSignIn, signOut, watch, and Host-only resolveRequestCredential, registerRunningTaskReport, and getPlatformSession. The platform provider implements it with an AuthorizationFlow and a private GrantRecord. AccountView distinguishes stored presence from server validation; attempt IDs bind cancellation to one local flow. AccountUpdate carries a complete AccountView in state and a type of snapshot for initial or progress updates, or credentials-changed for credential writes and removal. Pending credential changes take priority over progress updates. See [the account package](../../packages/account/deepseek-account/README.md).

`AccountClientMetadata` carries `version` from the caller’s `DSH_CLIENT_VERSION`, its active UI `locale`, and `timezoneOffsetSeconds` sampled when the operation begins. The offset is local time minus UTC in seconds: UTC+8 is `28800`. It contains no credentials. Login attempts retain their initiating metadata through exchange and cancellation; sign-out retains its metadata for revocation retries.
