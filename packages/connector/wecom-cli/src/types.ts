import type { Branded } from '@deepseek-ai/dsh-brand'

export type WecomOperationId = Branded<'WecomOperationId'>

export interface WecomAccountState {
  readonly state: 'unchecked' | 'unauthorized' | 'authorized'
}

export interface WecomOperationState {
  readonly id: WecomOperationId
  readonly kind: 'check' | 'connect'
  readonly phase: 'checking' | 'authorizing' | 'verifying' | 'cancelling'
  readonly authorizationUrl?: string
}

export interface WecomOperationResult {
  readonly id: WecomOperationId
  readonly kind: WecomOperationState['kind']
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
}

export interface WecomState {
  readonly account: WecomAccountState
  readonly operation?: WecomOperationState
  readonly result?: WecomOperationResult
}
