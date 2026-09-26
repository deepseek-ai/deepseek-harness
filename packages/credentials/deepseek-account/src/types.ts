/** Client-supplied request identity and client-safe account state; credentials never cross this projection. */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

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
/** Safe failure codes rendered through the caller's locale dictionary. */
export type SignInErrorCode = 'network' | 'protocol' | 'expired' | 'storage'
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

/** Identity of one granted bonus order; stable across devices and sign-ins. */
export type AccountBonusOrderId = Branded<'AccountBonusOrderId'>
/** One granted bonus Platform has not yet recorded as displayed; copy is server-authored. */
export interface AccountBonusNotification {
  readonly orderId: AccountBonusOrderId
  readonly campaign: string
  /** Granted decimal amount, preserving server precision; never the remaining balance. */
  readonly amount: string
  readonly currency: 'CNY' | 'USD'
  /** Grant time as supplied by Platform. */
  readonly grantedAt: string
  /** Expiry as supplied by Platform. */
  readonly expiresAt: string
  /** Server-localized plain text ready for display. */
  readonly message: string
}
/** Unnotified bonuses with the account they belong to, in Platform order. */
export interface AccountBonusBatch {
  readonly accountId: AccountUserId
  readonly bonuses: readonly AccountBonusNotification[]
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
