/** Credential-free DingTalk account and operation views the Plugins page presenter reads. */

import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'

/**
 * The current dws account as the latest check observed it. `not-installed` means the managed dws was missing and the
 * download that check started did not finish; `unverified` covers the sign-ins dws itself cannot judge.
 */
export type DingtalkAccountState =
  | { readonly state: 'unchecked' | 'not-installed' | 'signed-out' | 'unverified' }
  | {
    readonly state: 'connected'
    /** The signed-in user's name, when `auth status` reports it. */
    readonly userName?: string
    /** The signed-in user's organization, when `auth status` reports it. */
    readonly corpName?: string
  }

/** The account operations the Plugins page starts. */
export type DingtalkOperationKind = 'check' | 'sign-in' | 'sign-out'

/** DingTalk steps of an operation, besides the Service's `checking` and `cancelling`. */
export type DingtalkPhase = 'downloading' | 'authorizing' | 'signing-out'

/** The dws commands an operation runs; a failed operation reports its last one with that command's exit code. */
export type DingtalkCommand = 'auth-status' | 'auth-login' | 'auth-logout'

/** The complete DingTalk view the presenter reads after each change. */
export type DingtalkState = CliAccountView<DingtalkAccountState, DingtalkOperationKind, DingtalkPhase, DingtalkCommand>
