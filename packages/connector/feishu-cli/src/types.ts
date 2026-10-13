/** Credential-free Feishu account and operation views for Remote clients. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one Host-owned account operation across subscribers. */
export type FeishuOperationId = Branded<'FeishuOperationId'>

/** The CLI's default account as the latest check observed it. */
export type FeishuAccountState =
  | { readonly state: 'unchecked' | 'unconfigured' | 'signed-out' | 'unverified' }
  | { readonly state: 'connected'; readonly userName?: string }

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
