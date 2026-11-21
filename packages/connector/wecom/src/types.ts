/** Credential-free WeCom authorization and operation views the Plugins page presenter reads. */

import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'

/**
 * The CLI's authorization as the latest `auth show` reported it. `not-installed` means the upstream guides were
 * missing and the download that check waited for did not finish.
 */
export interface WecomAccountState {
  readonly state: 'unchecked' | 'not-installed' | 'unauthorized' | 'authorized'
  /** The bound bot's id, when the CLI reports one with an authorized state. */
  readonly botId?: string
}

/** The operations the Plugins page starts. */
export type WecomOperationKind = 'check' | 'connect'

/** WeCom steps of an operation, besides the Service's `checking` and `cancelling`. */
export type WecomPhase = 'downloading' | 'authorizing'

/** The wecom-cli commands an operation runs; a failed operation reports its last one with that command's exit code. */
export type WecomCommand = 'auth-init' | 'auth-status'

/** The complete WeCom view the presenter reads after each change. */
export type WecomState = CliAccountView<WecomAccountState, WecomOperationKind, WecomPhase, WecomCommand>
