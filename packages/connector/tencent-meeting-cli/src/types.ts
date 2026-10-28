/** Credential-free Tencent Meeting account and operation views for Remote clients. */

import type { CliAccountView, CliCommandFailure } from '@deepseek-ai/dsh-cli-account/types'
import type { UpstreamSkillsState } from '@deepseek-ai/dsh-upstream-skills/types'

/** The default tmeet account as the latest `auth status` observed it. */
export type TencentMeetingSignIn =
  | { readonly state: 'unchecked' | 'signed-out' | 'unverified' }
  | { readonly state: 'connected'; readonly userName: string }

/** The default tmeet account and where the upstream guide stands. */
export type TencentMeetingAccountState = TencentMeetingSignIn & {
  /** Whether the guide the `tencent-meeting` skill indexes is in place, downloading, or unavailable until a check retries it. */
  readonly skills: UpstreamSkillsState
}

/** The account operations the Plugins page starts. */
export type TencentMeetingOperationKind = 'check' | 'sign-in' | 'sign-out'

/** Tencent Meeting steps of an operation, besides the runtime's `checking` and `cancelling`. */
export type TencentMeetingPhase = 'authorizing' | 'signing-out'

/** The command and exit code of a failed operation's last command. */
export type TencentMeetingOperationFailure = CliCommandFailure<'auth-status' | 'auth-login' | 'auth-logout'>

/** The complete Tencent Meeting view a Remote client replaces on every change. */
export type TencentMeetingState = CliAccountView<
  TencentMeetingAccountState, TencentMeetingOperationKind, TencentMeetingPhase, TencentMeetingOperationFailure
>
