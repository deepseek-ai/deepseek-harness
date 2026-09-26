/** Operations available to the isolated native welcome renderer. */

import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  saveApiKey: 'dsh-welcome:save-api-key',
  skip: 'dsh-welcome:skip',
  start: 'dsh-welcome:start',
  cancel: 'dsh-welcome:cancel',
  copyLink: 'dsh-welcome:copy-link',
  state: 'dsh-welcome:state',
  takeNotice: 'dsh-welcome:take-notice',
} as const

/** Credential writes return a safe outcome without exposing Host diagnostics. */
export type WelcomeSaveResult = { readonly ok: true } | { readonly ok: false }

/** One-time notification retained by the main process until Welcome receives it. */
export type WelcomeNotice = 'session-expired'

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @returns the pending notification, clearing it before another renderer can receive it. */
  takeNotice(): Promise<WelcomeNotice | undefined>
  /** @returns account state after starting a login attempt. */
  startSignIn(): Promise<AccountView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancelSignIn(id: SignInAttemptId): Promise<AccountView>
  /** @param id - current waiting attempt whose authorization URL is copied to the system clipboard. */
  copySignInLink(id: SignInAttemptId): Promise<void>

  /**
   * Store the official provider's key before entering the workspace.
   * @param value - validated, trimmed API key.
   * @returns whether the write completed, without private error details.
   */
  saveApiKey(value: string): Promise<WelcomeSaveResult>
  /**
   * Enter the workspace without writing an onboarding-completion setting.
   * @returns completion after the workspace opens.
   */
  skip(): Promise<void>
}

/** The renderer receives localized copy, login operations, and safe account snapshots. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & {
  /** @param listener - safe account snapshot recipient. @returns subscription disposer. */
  onAccountState(listener: (state: AccountView) => void): () => void
}

/** Authentication facts supplied at cold start or after a completed sign-out. */
export interface WelcomeAuthentication {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
}

/**
 * Decide whether a startup or sign-out requires the welcome entry.
 * @param authentication - current account and independently stored API-key facts.
 * @returns true only when neither authentication route is configured.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.loggedIn && !authentication.hasApiKey
}
