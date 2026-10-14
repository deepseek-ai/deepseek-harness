/** Credential-free WeCom authorization and operation views for Remote clients. */

import type { CliAccountView, CliCommandFailure } from '@deepseek-ai/dsh-cli-account/types'

/** The CLI's authorization as the latest `auth show --status` reported it. */
export interface WecomAccountState {
  readonly state: 'unchecked' | 'unauthorized' | 'authorized'
}

/** The operations the Plugins page starts. */
export type WecomOperationKind = 'check' | 'connect'

/** The WeCom step of an operation, besides the runtime's `checking` and `cancelling`. */
export type WecomPhase = 'authorizing'

/** The command and exit code of a failed operation's last command. */
export type WecomOperationFailure = CliCommandFailure<'auth-init' | 'auth-status'>

/** The complete WeCom view a Remote client replaces on every change. */
export type WecomState = CliAccountView<WecomAccountState, WecomOperationKind, WecomPhase, WecomOperationFailure>
