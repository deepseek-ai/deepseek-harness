/** Credential-free Feishu account and operation views the Plugins page presenter reads. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CliAccountView, CliCommandFailure } from '@deepseek-ai/dsh-cli-account/types'

/** The Feishu app the CLI's default configuration uses, as `auth status` reports it. */
export type FeishuAppId = Branded<'FeishuAppId'>

/** The CLI's default account as the latest check observed it. */
export type FeishuAccountState =
  | { readonly state: 'unchecked' | 'unconfigured' }
  | { readonly state: 'signed-out' | 'unverified'; readonly appId: FeishuAppId }
  | { readonly state: 'connected'; readonly appId: FeishuAppId; readonly userName?: string }

/** The account operations the Plugins page starts. */
export type FeishuOperationKind = 'check' | 'link-app' | 'sign-in' | 'sign-out'

/** Feishu steps of an operation, besides the runtime's `checking` and `cancelling`. */
export type FeishuPhase = 'configuring' | 'authorizing' | 'verifying' | 'signing-out'

/** The command and exit code of a failed operation's last command; native messages, paths, and credentials are excluded. */
export type FeishuOperationFailure = CliCommandFailure<'config-init' | 'auth-status' | 'auth-login' | 'auth-logout'>

/** The complete Feishu view the presenter reads after each change. */
export type FeishuState = CliAccountView<FeishuAccountState, FeishuOperationKind, FeishuPhase, FeishuOperationFailure>
