/**
 * What an app plugin registers with `ctx.cliAccounts` and gets back: the registration, the control its operations
 * receive, the handle, and the credential-free account view. The Plugins page display types come from
 * `@deepseek-ai/dsh-client-ui-connector-account/types`.
 */

import type {
  ConnectorAccountCopy, ConnectorAccountDisplay, ConnectorAccountOperation, ConnectorAccountView,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { CliPathContext } from './context.ts'
import type { CliCommandResult, CliRunOptions } from './executor.ts'

/** The last command a failed operation ran and its exit code. */
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
 * the plugin's, or the Service's own `checking` and `cancelling`; a failed operation that ran a command reports that
 * command and its exit code.
 */
export type CliAccountView<Account, Kind extends string, Phase extends string, Command extends string = string> =
  ConnectorAccountView<Account, Kind, Phase | 'checking' | 'cancelling', CliCommandFailure<Command>>

/** A plugin's Plugins page dictionaries by language; English is required, as `LocalizedText` falls back to it. */
export type CliAccountDictionaries<Key extends string> =
  & { readonly en: Readonly<Record<Key, string>> }
  & { readonly [language: string]: Readonly<Record<Key, string>> }

/**
 * Write one key of the plugin's dictionaries as text in every language they hold; the browser resolves the result in
 * its active language.
 * @param key - the dictionary key.
 * @param params - values that replace each `{name}` placeholder; a placeholder without a value stays as written.
 * @returns the text in every language.
 */
export type CliAccountText<Key extends string> = (key: Key, params?: Readonly<Record<string, string>>) => LocalizedText

/** What a plugin's operation may do while it runs. */
export interface CliOperationControl<Account, Phase extends string, Command extends string> {
  /**
   * Enter a phase and withdraw the current link.
   * @param phase - the plugin's phase, or `checking` for a check that follows another step.
   * @throws the cancellation reason after the operation was cancelled.
   */
  stage(phase: Phase | 'checking'): void
  /**
   * Offer an authorization link to the page; an untrusted, malformed, or late link is ignored.
   * @param url - an HTTPS URL on one of the plugin's authorization hosts or their subdomains, without credentials.
   * @returns whether the page now shows the link.
   */
  offer(url: string): boolean
  /**
   * Run one command of the plugin's CLI and record it, with its exit code, as the operation's failure if the operation
   * then fails. Its pipes are read until they close, at most until 2 seconds after the process exits.
   * @param command - the plugin's identifier for the command.
   * @param args - native arguments without the executable.
   * @param signal - the operation's signal.
   * @param options - the deadline choice and an output-line observer.
   * @returns the command's exit code and output, whatever the exit code.
   * @throws with the subprocess runtime's error when executable lookup fails or the process cannot spawn; with what
   *   `onLine` throws; with the reason of `signal` after it aborts; otherwise, with a message naming the command, when
   *   the deadline elapses, the process ends by a signal, or stdout exceeds 1 MiB.
   */
  run(command: Command, args: readonly string[], signal: AbortSignal, options?: CliRunOptions): Promise<CliCommandResult>
  /**
   * Replace the account the view reports and notify subscribers.
   * @param account - the account the latest check observed.
   */
  publish(account: Account): void
}

/**
 * One app plugin's CLI, account operations, and Plugins page text. `Account` is the plugin's credential-free account
 * state, `Kind` its operations, `Phase` its operation phases, `Command` its command identifiers, and `Key` its
 * dictionary keys.
 */
export interface CliAccountRegistration<
  Account, Kind extends string, Phase extends string, Command extends string, Key extends string,
> {
  /**
   * The plugin's short name, such as `wecom`: the prefix of its errors and log records, and the stem of its
   * runtime-context name `<name>:cli`, which must be unique across plugins.
   */
  readonly name: string
  /** The plugin's npm package name: its account key on the Plugins page, shown on that package's page. */
  readonly packageName: string
  /** The CLI the model runs by its absolute path and the operations run commands of. */
  readonly cli: CliPathContext
  /** The account before the first check. */
  readonly account: Account
  /** The operation each new Plugins page subscriber starts when none runs. */
  readonly check: Kind
  /** The plugin phases in which the page can cancel an operation; `checking` and `cancelling` are never cancellable. */
  readonly cancellable: readonly Phase[]
  /**
   * Hosts whose HTTPS links, and their subdomains' links, may reach the page. Write each in lowercase ASCII, with an
   * internationalized domain name in punycode: they are compared with the URL's normalized `hostname`.
   */
  readonly authorizationHosts: readonly string[]
  /**
   * Carry out one operation. Throwing fails it, unless the operation was cancelled. What it throws is neither logged
   * nor shown, because exceptions and native output may contain credentials; a failed operation reports only its last
   * command and that command's exit code.
   * @param kind - the requested operation.
   * @param control - phase changes, link offers, command runs, and account updates for this operation.
   * @param signal - aborts on cancellation and when the plugin unloads.
   * @returns after the operation finishes.
   */
  perform(kind: Kind, control: CliOperationControl<Account, Phase, Command>, signal: AbortSignal): Promise<void>
  /** The dictionaries `operations`, `copy`, and `present` write their text from. */
  readonly dictionaries: CliAccountDictionaries<Key>
  /**
   * List the operations a page button may start, each with the notice the page shows after it succeeds. Called once,
   * during registration.
   * @param text - writes a dictionary key in every language.
   * @returns the operations; the page can start no other.
   */
  operations(text: CliAccountText<Key>): readonly ConnectorAccountOperation<Kind>[]
  /**
   * Write the fixed text of the plugin's account section. Called once, during registration.
   * @param text - writes a dictionary key in every language.
   * @returns the section's title, hint, and activation prompt.
   */
  copy(text: CliAccountText<Key>): ConnectorAccountCopy
  /**
   * Map the current view to what the account section shows; called on each change for each subscriber.
   * @param view - the account, the active operation, and the last result.
   * @param text - writes a dictionary key in every language.
   * @returns the display. For a failed operation that ran a command, write only the failure's `text`; the Service sets
   *   its `details` to that command and exit code.
   */
  present(view: CliAccountView<Account, Kind, Phase, Command>, text: CliAccountText<Key>): ConnectorAccountDisplay
}

/** A registered account, for the plugin's own reads and updates outside an operation. */
export interface CliAccountHandle<Account, Kind extends string, Phase extends string, Command extends string> {
  /**
   * Read the account, the active operation, and the last result.
   * @returns a view without credentials.
   */
  snapshot(): CliAccountView<Account, Kind, Phase, Command>
  /**
   * Replace the account the view reports and notify subscribers.
   * @param account - the account to report, such as the current one with a field the plugin observed elsewhere.
   */
  publish(account: Account): void
  /** Start a check unless an operation already runs or the account is withdrawn. */
  refresh(): void
  /**
   * Withdraw the account before the plugin unloads: remove it from the Plugins page, cancel the active operation, wait
   * for it and for the CLI processes it started, then remove the CLI path context. Unloading the plugin does the same.
   * @returns after that teardown finishes; every call returns the same promise.
   */
  dispose(): Promise<void>
}
