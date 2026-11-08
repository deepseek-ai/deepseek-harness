/** Client-supplied request identity and client-safe account state; credentials never cross this projection. */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Identity of the requesting UI for one account operation; the Host derives Platform request headers from it. */
export interface AccountClientMetadata {
  readonly version: string
  /** Active UI language; only its primary subtag selects the Platform wire locale. */
  readonly locale: string
  /** Offset from UTC in seconds, positive east of Greenwich. */
  readonly timezoneOffsetSeconds: number
}

/** Identity of one local login attempt, unrelated to the platform request ID. */
export type SignInAttemptId = Branded<'SignInAttemptId'>
/**
 * Safe failure codes rendered through the caller's locale dictionary.
 * `no-response`: fetch returned no Response; `network`: HTTP or account-detail retrieval failure.
 * `protocol`: invalid response or authorization data; `expired`: authorization expired;
 * `storage`: local credential access or commit failed.
 */
export type SignInErrorCode = 'no-response' | 'network' | 'protocol' | 'expired' | 'storage'
/** Latest login attempt, including terminal outcomes until the next attempt. */
export interface SignInAttemptView {
  readonly id: SignInAttemptId
  readonly phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: SignInErrorCode
}
/** Browser destinations derived from the Host's platform configuration; never carry tokens. */
export interface AccountLinks {
  readonly usageUrl: string
  readonly topUpUrl: string
}
/** Stored-account presence is not a claim that the server has validated its token. */
export interface AccountView {
  readonly status: 'signed-out' | 'credential-stored'
  readonly links: AccountLinks
  readonly attempt: SignInAttemptView | null
}

/** Ordered account stream item; every item carries the latest safe state. */
export interface AccountUpdate {
  /** Initial state and progress use snapshot; credential writes and removal use credentials-changed. */
  readonly type: 'snapshot' | 'credentials-changed'
  readonly state: AccountView
}

/** Platform account identifier supplied by the current-user endpoint. */
export type AccountUserId = Branded<'AccountUserId'>
/** Display identity; contacts retain Platform masking. */
export interface AccountProfile {
  readonly id: AccountUserId | null
  readonly name: string | null
  readonly contact: string | null
  /** Profile image URL supplied by Platform, absent when no picture is configured. */
  readonly avatarUrl?: string | null
}
/** Platform recharge or bonus wallet balance; decimal strings retain server precision. */
export interface AccountWallet {
  readonly currency: 'CNY' | 'USD'
  readonly balance: string
}
/** Independent query outcomes allow profile and balance failures to render separately. */
export interface AccountDetails {
  readonly profile: { readonly status: 'ready'; readonly value: AccountProfile } | { readonly status: 'failed' }
  readonly balance: { readonly status: 'ready'; readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] } | { readonly status: 'failed' }
}

/** Opaque string notification identity; stable across devices, sign-ins, and languages. */
export type AccountNotificationId = Branded<'AccountNotificationId'>
/** Presentation, any non-dismiss action click, or explicit dismissal; independent of backend consumption. */
export type AccountNotificationEvent = 'displayed' | 'cta_clicked' | 'dismissed'
/** Client action supported by the account notification presentation. */
export interface AccountNotificationAction {
  readonly label: string
  readonly style: 'primary' | 'secondary'
  readonly target: { readonly type: 'app_route'; readonly name: 'account' } | { readonly type: 'dismiss' }
}
/** One account notification with server-localized plain text and actions. */
export interface AccountNotification {
  readonly id: AccountNotificationId
  readonly createdAt: string
  /** Display deadline; null means the notification never expires. */
  readonly displayUntil: string | null
  readonly title: string
  readonly body: string
  readonly actions: readonly AccountNotificationAction[]
  /** Optional business data, retained independently of the localized copy. */
  readonly data?: JsonValue
}
/** Unconsumed notifications in server order, without account-profile data. */
export interface AccountNotificationBatch {
  /** Positive delay in seconds before querying again, within the browser timer range. */
  readonly nextPollAfterSeconds: number
  readonly notifications: readonly AccountNotification[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Server rejection removed the current account credential; this notification is not replayed.
     * @mode emit
     */
    'deepseek-account/session-expired'(): void
    /** An account model request requires the user to sign in.
     * @mode emit
     */
    'deepseek-account/model-sign-in-required'(): void
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
