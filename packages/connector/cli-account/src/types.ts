/**
 * Credential-free account views of CLI app plugins: each plugin supplies its own account, operation, and failure types,
 * and the runtime adds its own phases to the plugin's. The Plugins page registration and display types come from
 * `@deepseek-ai/dsh-client-ui-connector-account/types`.
 */

import type { ConnectorAccountView } from '@deepseek-ai/dsh-client-ui-connector-account/types'

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

/**
 * The complete account view of a CLI app plugin; observers reread it after each change. An operation's phase is one of
 * the plugin's, or the runtime's own `checking` and `cancelling`; a failed operation that ran a command reports its
 * classification.
 */
export type CliAccountView<Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure = CliCommandFailure> =
  ConnectorAccountView<Account, Kind, Phase | 'checking' | 'cancelling', Failure>

/** A plugin's Plugins page dictionaries by language; English is required, as `LocalizedText` falls back to it. */
export type CliAccountDictionaries<Key extends string> =
  & { readonly en: Readonly<Record<Key, string>> }
  & { readonly [language: string]: Readonly<Record<Key, string>> }
