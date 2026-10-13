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
  | {
    readonly state: 'connected'
    readonly appId: FeishuAppId
    readonly userName?: string
    /**
     * Requested permissions the last sign-in on this Host did not grant, which may await an administrator's
     * approval; absent when every permission was granted or no sign-in ran since the Host started.
     */
    readonly ungrantedPermissions?: number
  }

/** The account operation in progress; links are restricted to HTTPS Feishu and Lark hosts. */
export interface FeishuOperationState {
  readonly id: FeishuOperationId
  readonly kind: 'check' | 'link-app' | 'sign-in' | 'sign-out'
  readonly phase: 'checking' | 'configuring' | 'authorizing' | 'verifying' | 'signing-out' | 'cancelling'
  readonly authorizationUrl?: string
}

/** The most recent finished operation, kept until another one starts. */
export interface FeishuOperationResult {
  readonly id: FeishuOperationId
  readonly kind: FeishuOperationState['kind']
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
}

/** The complete view a Remote client replaces on every change. */
export interface FeishuState {
  readonly account: FeishuAccountState
  readonly operation?: FeishuOperationState
  readonly result?: FeishuOperationResult
}
