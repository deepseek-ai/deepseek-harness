/** Credential-free Feishu account and operation views for Remote clients. */

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

/** Safe account-command diagnostics; native messages, paths, and credentials are excluded. */
export interface FeishuOperationFailure extends CliCommandFailure<'config-init' | 'auth-status' | 'auth-login' | 'auth-logout'> {
  /** A recognized CLI error category; absent for unrecognized or unreadable error output. */
  readonly type?: 'validation' | 'authentication' | 'authorization' | 'config' | 'network' | 'api' | 'policy' | 'internal' | 'confirmation'
  /** A recognized account or storage error subtype; other subtypes are omitted. */
  readonly subtype?: 'sdk_error' | 'storage' | 'file_io' | 'not_configured' | 'invalid_config' | 'invalid_client'
}

/** The complete Feishu view a Remote client replaces on every change. */
export type FeishuState = CliAccountView<FeishuAccountState, FeishuOperationKind, FeishuPhase, FeishuOperationFailure>
