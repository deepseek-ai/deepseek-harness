/** Credential-free WeCom authorization and operation views the Plugins page presenter reads. */

import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'
import type { UpstreamSkillsState } from '@deepseek-ai/dsh-upstream-skills/types'

/** The CLI's authorization as the latest `auth show` reported it, and where the upstream guides stand. */
export interface WecomAccountState {
  readonly state: 'unchecked' | 'unauthorized' | 'authorized'
  /** The bound bot's id, when the CLI reports one with an authorized state. */
  readonly botId?: string
  /** Whether the guides the `wecom` skill indexes are in place, downloading, or unavailable until a check retries them. */
  readonly skills: UpstreamSkillsState
}

/** The operations the Plugins page starts. */
export type WecomOperationKind = 'check' | 'connect'

/** The WeCom step of an operation, besides the Service's `checking` and `cancelling`. */
export type WecomPhase = 'authorizing'

/** The wecom-cli commands an operation runs; a failed operation reports its last one with that command's exit code. */
export type WecomCommand = 'auth-init' | 'auth-status'

/** The complete WeCom view the presenter reads after each change. */
export type WecomState = CliAccountView<WecomAccountState, WecomOperationKind, WecomPhase, WecomCommand>
