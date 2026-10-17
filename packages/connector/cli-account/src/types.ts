/**
 * Credential-free account views that CLI plugins stream to the Plugins page; each plugin supplies its own account,
 * operation, and failure types.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one Host-owned account operation across the plugin's subscribers. */
export type CliOperationId = Branded<'CliOperationId'>

/**
 * The account operation in progress. `checking` and `cancelling` are the runtime's phases;
 * `Phase` adds the plugin's own. Links are HTTPS URLs on the plugin's trusted hosts.
 */
export interface CliOperation<Kind extends string, Phase extends string> {
  readonly id: CliOperationId
  readonly kind: Kind
  readonly phase: Phase | 'checking' | 'cancelling'
  /** Whether the runtime cancels the operation in its current phase. */
  readonly cancellable: boolean
  readonly authorizationUrl?: string
}

/** Classified facts about the last command a failed operation ran; plugins extend it with allowlisted fields only. */
export interface CliCommandFailure<Command extends string = string> {
  /** The plugin's identifier for the command, not its native arguments. */
  readonly command: Command
  /**
   * The observed exit code; null when running the command yielded none: executable lookup or spawn failed, the deadline
   * elapsed, the process ended by a signal, its stdout exceeded 1 MiB, or the plugin's `onLine` observer threw.
   */
  readonly exitCode: number | null
}

/** The most recent finished operation, kept until another one starts. */
export interface CliOperationResult<Kind extends string, Failure extends CliCommandFailure = CliCommandFailure> {
  readonly id: CliOperationId
  readonly kind: Kind
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
  /** Present only for a failed operation that ran a command; does not imply rollback or a safe retry. */
  readonly failure?: Failure
}

/** The complete view a Remote client replaces on every change. */
export interface CliAccountView<Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure = CliCommandFailure> {
  /** The account as the plugin last published it. */
  readonly account: Account
  readonly operation?: CliOperation<Kind, Phase>
  readonly result?: CliOperationResult<Kind, Failure>
}
