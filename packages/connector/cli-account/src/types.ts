import type { Branded } from '@deepseek-ai/dsh-brand'

export type CliOperationId = Branded<'CliOperationId'>

export interface CliOperation<Kind extends string, Phase extends string> {
  readonly id: CliOperationId
  readonly kind: Kind
  readonly phase: Phase | 'checking' | 'cancelling'
  readonly cancellable: boolean
  readonly authorizationUrl?: string
}

export interface CliCommandFailure<Command extends string = string> {
  readonly command: Command
  readonly exitCode: number | null
}

export interface CliOperationResult<Kind extends string, Failure extends CliCommandFailure = CliCommandFailure> {
  readonly id: CliOperationId
  readonly kind: Kind
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
  readonly failure?: Failure
}

export interface CliAccountView<Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure = CliCommandFailure> {
  readonly account: Account
  readonly operation?: CliOperation<Kind, Phase>
  readonly result?: CliOperationResult<Kind, Failure>
}
