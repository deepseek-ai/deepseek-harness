/** Account Service Definition shared by platform, API, and model consumers. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountUserId, AccountView, SignInAttemptId } from './types.ts'
export type { AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountProfile, AccountUserId, AccountWallet, AccountLinks, AccountView, SignInAttemptId, SignInAttemptView, SignInErrorCode } from './types.ts'
export { isRunningAccountTask, installAccountTaskCancellation } from './account-tasks.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Local grant removal has completed.
     * @mode emit
     */
    'deepseek-account/signed-out'(): void
  }
  interface Context {
    deepseekAccount: DeepSeekAccount
  }
}

/** Host-only credentials for an embedded Platform document; never expose through account RPC. */
export interface PlatformSession {
  readonly origin: string
  readonly token: string
  /** Stable issuer account ID from the last successful profile read; null requires disposable browser storage. */
  readonly userId: AccountUserId | null
  /** Optional dist query value selecting the embedded frontend deployment. */
  readonly embeddedPageDist?: string
  /** Host-only deployment request headers; the consuming client adds its own dynamic identity, and neither reaches renderer bootstrap. */
  readonly requestHeaders?: Readonly<Record<string, string>>
}

/** Account operations; only Host consumers can obtain a request credential. */
export abstract class DeepSeekAccount extends Service {
  /** @param ctx - context owning this account implementation. */
  constructor(ctx: Context) { super(ctx, 'deepseekAccount') }
  /**
   * Read stored-account presence and the latest login attempt.
   * @returns a snapshot without credentials or PKCE secrets.
   */
  abstract getState(): Promise<AccountView>
  /**
   * Query Platform profile independently of wallet balances.
   * A ready result whose stable profile ID first becomes available or changes notifies watch
   * consumers, so identity consumers re-read getPlatformSession; repeated IDs stay silent.
   * @param client - identity of the requesting UI for this call.
   * @returns profile outcome, or null if signed out or the grant changed during the query.
   */
  abstract getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null>
  /**
   * Query Platform recharge and bonus wallet balances independently of profile data.
   * @param client - identity of the requesting UI for this call.
   * @returns balance outcome, or null if signed out or the grant changed during the query.
   */
  abstract getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null>
  /**
   * Query the granted bonuses Platform has not yet recorded as displayed.
   * @param client - identity of the requesting UI for this call; its language selects the server-authored message.
   * @returns bonuses with their account, or null if signed out or the grant changed during the query.
   */
  abstract getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null>
  /**
   * Record one displayed bonus as notified for the account it belongs to.
   * @param accountId - account the notification was read for; a different current account is never acknowledged.
   * @param orderId - granted bonus order the user saw.
   * @param client - identity of the requesting UI for this call.
   * @returns true once Platform records the acknowledgement; false if signed out or the account changed.
   */
  abstract ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean>
  /**
   * Join an active attempt or start browser authorization.
   * @param client - identity of the requesting UI; a new attempt captures it, and joining retains the original attempt's identity.
   * @param callbackOrigin - browser-accessible loopback HTTP origin, including any SSH local port.
   * @param loginSource - initiating UI, used to return from a failed exchange.
   * @returns the initial snapshot without waiting for browser approval.
   */
  abstract startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView>
  /**
   * Cancel only the named attempt; committing attempts settle before returning.
   * @param id - attempt identity from this Host.
   * @returns state after cancellation or an already-started commit.
   */
  abstract cancelSignIn(id: SignInAttemptId): Promise<AccountView>
  /**
   * Remove the local grant while retaining API keys; the provider revokes it in the background.
   * @param client - identity of the requesting UI, captured for the background revocation retries.
   * @returns the signed-out state after local removal; remote failures never restore the grant.
   */
  abstract signOut(client: AccountClientMetadata): Promise<AccountView>
  /**
   * Subscribe to snapshots including a complete initial state.
   * @param signal - subscription lifetime; ending it never cancels login.
   * @returns complete snapshots as account state changes.
   */
  abstract watch(signal: AbortSignal): AsyncIterable<AccountView>
  /**
   * Resolve a credential only for the inference origin allowed by the provider.
   * @param url - actual request destination or API base URL.
   * @returns stored token, or undefined for other origins or a signed-out account.
   */
  abstract resolveToken(url: string): Promise<string | undefined>
  /**
   * Remove an inference-rejected token only while it still matches the stored login.
   * @param token - token captured by the rejected inference request.
   * @returns after matching credentials are removed and the expiry notification is emitted.
   */
  abstract rejectToken(token: string): Promise<void>
  /**
   * Read credentials for the configured Platform origin, bound to their issuing environment, and
   * pair them with the account ID from the last successful profile read; no profile request is made.
   * @returns a Host-only snapshot, or null while signed out or when the credential changed during the read.
   */
  abstract getPlatformSession(): Promise<PlatformSession | null>
}
export default DeepSeekAccount


/** Merge Cookie header pairs by case-sensitive name, retaining unrelated cookies.
 * @param base - existing request cookies.
 * @param override - deployment cookies whose values take precedence.
 * @returns one Cookie header with at most one pair per name.
 */
export function mergePlatformCookies(base: string, override: string): string {
  const cookies = new Map<string, string>()
  for (const header of [base, override]) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Identify native desktop API requests; null leaves non-desktop requests unchanged.
 * @param platform - Operating system supplied by the desktop composition.
 * @returns Platform request headers shared by account and update-policy clients.
 */
export function desktopClientHeaders(platform: 'darwin' | 'win32' | null): Record<string, string> {
  if (platform === null) return {}
  return { 'x-client-platform': platform === 'win32' ? 'desktop-win' : 'desktop-mac' }
}

/**
 * Build the Platform client identity headers for one call.
 * @param platform - Operating system supplied by the desktop composition; null identifies the client as web.
 * @param client - identity of the requesting UI for this call.
 * @returns the five client headers; the bundle ID is intentionally empty.
 */
export function platformClientHeaders(platform: 'darwin' | 'win32' | null, client: AccountClientMetadata): Record<string, string> {
  return {
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    ...desktopClientHeaders(platform),
    'x-client-version': client.version,
    'x-client-locale': platformWireLocale(client.locale),
    'x-client-timezone-offset': String(client.timezoneOffsetSeconds),
  }
}

/**
 * Reduce a caller's UI language to the region-tagged Platform locale.
 * Shares one normalization with the header and with request body locale fields.
 * @param locale - active UI language such as `zh-CN`, `zh_TW`, or `en-US`.
 * @returns the region-tagged Platform locale for that language, `zh_CN` or `en_US`.
 */
export function platformWireLocale(locale: string): 'zh_CN' | 'en_US' {
  return locale.toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh_CN' : 'en_US'
}
