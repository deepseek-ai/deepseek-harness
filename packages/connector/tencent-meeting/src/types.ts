/** Credential-free Tencent Meeting account and operation views the Plugins page presenter reads. */

import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'
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

/** Tencent Meeting steps of an operation, besides the Service's `checking` and `cancelling`. */
export type TencentMeetingPhase = 'authorizing' | 'signing-out'

/** The tmeet commands an operation runs; a failed operation reports its last one with that command's exit code. */
export type TencentMeetingCommand = 'auth-status' | 'auth-login' | 'auth-logout'

/** The complete Tencent Meeting view the presenter reads after each change. */
export type TencentMeetingState = CliAccountView<
  TencentMeetingAccountState, TencentMeetingOperationKind, TencentMeetingPhase, TencentMeetingCommand
>
