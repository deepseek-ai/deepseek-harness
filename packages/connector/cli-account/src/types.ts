import type { Branded } from '@deepseek-ai/dsh-brand'

export type CliOperationId = Branded<'CliOperationId'>

export interface CliOperation<Kind extends string, Phase extends string> {
  readonly id: CliOperationId
  readonly kind: Kind
  readonly phase: Phase | 'checking' | 'cancelling'
  readonly cancellable: boolean
  readonly authorizationUrl?: string
}

export interface CliOperationResult<Kind extends string> {
  readonly id: CliOperationId
  readonly kind: Kind
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
}

export interface CliAccountView<Account, Kind extends string, Phase extends string> {
  readonly account: Account
  readonly operation?: CliOperation<Kind, Phase>
  readonly result?: CliOperationResult<Kind>
}
