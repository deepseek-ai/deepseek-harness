/** Credential-free Tencent Meeting account and operation views the Plugins page presenter reads. */

import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'

/**
 * The default tmeet account as the latest `auth status` observed it. `not-installed` means the upstream guide was
 * missing and the download that check waited for did not finish.
 */
export type TencentMeetingAccountState =
  | { readonly state: 'unchecked' | 'not-installed' | 'signed-out' | 'unverified' }
  | { readonly state: 'connected'; readonly userName: string }

/** The account operations the Plugins page starts. */
export type TencentMeetingOperationKind = 'check' | 'sign-in' | 'sign-out'

/** Tencent Meeting steps of an operation, besides the Service's `checking` and `cancelling`. */
export type TencentMeetingPhase = 'downloading' | 'authorizing' | 'signing-out'

/** The tmeet commands an operation runs; a failed operation reports its last one with that command's exit code. */
export type TencentMeetingCommand = 'auth-status' | 'auth-login' | 'auth-logout'

/** The complete Tencent Meeting view the presenter reads after each change. */
export type TencentMeetingState = CliAccountView<
  TencentMeetingAccountState, TencentMeetingOperationKind, TencentMeetingPhase, TencentMeetingCommand
>
