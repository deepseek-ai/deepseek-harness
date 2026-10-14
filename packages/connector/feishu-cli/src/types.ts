/** Credential-free Feishu account and operation views for Remote clients. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one Host-owned account operation across subscribers. */
export type FeishuOperationId = Branded<'FeishuOperationId'>

/** The Feishu app the CLI's default configuration uses, as `auth status` reports it. */
export type FeishuAppId = Branded<'FeishuAppId'>

/** The CLI's default account as the latest check observed it. */
export type FeishuAccountState =
  | { readonly state: 'unchecked' | 'unconfigured' }
  | { readonly state: 'signed-out' | 'unverified'; readonly appId: FeishuAppId }
  | { readonly state: 'connected'; readonly appId: FeishuAppId; readonly userName?: string }

/** The account operation in progress; links are restricted to HTTPS Feishu and Lark hosts. */
export interface FeishuOperationState {
  readonly id: FeishuOperationId
  readonly kind: 'check' | 'link-app' | 'sign-in' | 'sign-out'
  readonly phase: 'checking' | 'configuring' | 'authorizing' | 'verifying' | 'signing-out' | 'cancelling'
  readonly authorizationUrl?: string
}

/** Safe account-command diagnostics; native messages, paths, and credentials are excluded. */
export interface FeishuOperationFailure {
  readonly command: 'config-init' | 'auth-status' | 'auth-login' | 'auth-logout'
  /** The observed process exit code; null when no normal exit code was observed. */
  readonly exitCode: number | null
  /** A recognized CLI error category; absent for unrecognized or unreadable error output. */
  readonly type?: 'validation' | 'authentication' | 'authorization' | 'config' | 'network' | 'api' | 'policy' | 'internal' | 'confirmation'
  /** A recognized account or storage error subtype; other subtypes are omitted. */
  readonly subtype?: 'sdk_error' | 'storage' | 'file_io' | 'not_configured' | 'invalid_config' | 'invalid_client'
}

/** The most recent finished operation, kept until another one starts. */
export interface FeishuOperationResult {
  readonly id: FeishuOperationId
  readonly kind: FeishuOperationState['kind']
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
  /** Present only for failed operations with an attempted CLI command; does not imply rollback or safe retry. */
  readonly failure?: FeishuOperationFailure
}

/** The complete view a Remote client replaces on every change. */
export interface FeishuState {
  readonly account: FeishuAccountState
  readonly operation?: FeishuOperationState
  readonly result?: FeishuOperationResult
}
