import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'

export interface WecomAccountState {
  readonly state: 'unchecked' | 'unauthorized' | 'authorized'
}

export type WecomOperationKind = 'check' | 'connect'

export type WecomPhase = 'authorizing'

export type WecomState = CliAccountView<WecomAccountState, WecomOperationKind, WecomPhase>
