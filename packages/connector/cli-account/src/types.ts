/**
 * Credential-free account views of CLI plugins, and what the Plugins page receives about them: each plugin supplies its
 * own account, operation, and failure types and maps its views to the page's display.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** Identifies one Host-owned account operation across the browsers that show the account. */
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

/** The complete account view; observers reread it after each change. */
export interface CliAccountView<Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure = CliCommandFailure> {
  /** The account as the plugin last published it. */
  readonly account: Account
  readonly operation?: CliOperation<Kind, Phase>
  readonly result?: CliOperationResult<Kind, Failure>
}

/** Any plugin's account view. */
export type AnyCliAccountView = CliAccountView<unknown, string, string>

/** The operation kinds a plugin's view reports. */
export type CliOperationKindOf<View extends AnyCliAccountView> = NonNullable<View['result']>['kind']

/** What the Plugins page shows about an account; each plugin maps its own account states onto these phases. */
export type CliAccountPhase = 'checking' | 'connecting' | 'connected' | 'disconnected' | 'unavailable'

/** What a section button does. */
export type CliAccountCommand =
  /** Start one of the operations the plugin registered as page actions. */
  | { readonly kind: 'start'; readonly operation: string }
  /** Cancel the operation in progress when it is cancellable. */
  | { readonly kind: 'cancel' }
  /** Open the current operation's authorization link again in this browser. */
  | { readonly kind: 'open' }

/** The question a button asks before it runs. */
export interface CliAccountConfirmation {
  readonly title: LocalizedText
  readonly body: LocalizedText
  /** The confirm button's label. */
  readonly label: LocalizedText
}

/** One button in the section. */
export interface CliAccountButton {
  readonly label: LocalizedText
  readonly command: CliAccountCommand
  /** Defaults to an outline button. */
  readonly variant?: 'primary' | 'ghost'
  /** Ask first, for an action that changes the account outside DSH, such as signing out of a CLI the terminal shares. */
  readonly confirm?: CliAccountConfirmation
}

/** One extra row under the status line, such as the linked app, with an optional button. */
export interface CliAccountNote {
  readonly text: LocalizedText
  readonly button?: CliAccountButton
}

/** A failed operation as the section reports it. */
export interface CliAccountFailure {
  /** The plugin's recovery guidance. */
  readonly text: LocalizedText
  /** The classified command, shown as a diagnostic after the guidance. */
  readonly command?: CliCommandFailure
  /** The plugin's allowlisted classification fields, appended in order. */
  readonly details?: readonly string[]
}

/** What the section shows for the current view; every text carries each shipped language. */
export interface CliAccountDisplay {
  readonly phase: CliAccountPhase
  readonly status: LocalizedText
  /** The tag beside the bundle title; absent while nothing is settled. */
  readonly badge?: LocalizedText
  /** The first `primary` button that asks no confirmation also answers Connect in the activation prompt. */
  readonly buttons: readonly CliAccountButton[]
  readonly detail?: LocalizedText
  readonly notes: readonly CliAccountNote[]
  readonly failure?: CliAccountFailure
}

/** The section's fixed text that names the product or uses its wording. */
export interface CliAccountCopy {
  readonly title: LocalizedText
  /** The line under the section, such as what the account is shared with. */
  readonly hint: LocalizedText
  /** The prompt after the bundle is switched on while the account is disconnected. */
  readonly activation: { readonly title: LocalizedText; readonly body: LocalizedText; readonly connect: LocalizedText }
}

/** One registered account as the Plugins page receives it. */
export interface CliAccountEntry {
  /** npm package whose bundle page carries the section and tag. */
  readonly packageName: string
  readonly copy: CliAccountCopy
  readonly display: CliAccountDisplay
  /** The operation in progress, which a browser follows when it started it. */
  readonly operation?: { readonly id: CliOperationId; readonly authorizationUrl?: string; readonly cancellable: boolean }
  /** The most recent finished operation; `notice` is the plugin's text for a success. */
  readonly result?: {
    readonly id: CliOperationId
    readonly outcome: CliOperationResult<string>['outcome']
    readonly notice?: LocalizedText
  }
}

/** Every registered account, as each change publishes it. */
export interface CliAccountsView {
  readonly accounts: readonly CliAccountEntry[]
}

/** The account a registration exposes to the page; `CliAccountRuntime` provides it. */
export interface CliAccountSource<View extends AnyCliAccountView> {
  snapshot(): View
  /** @returns a disposer; the listener runs after each change without starting a check. */
  observe(listener: () => void): () => void
  /** Start a check unless an operation runs. */
  refresh(): void
  /** @returns the started operation's identity. */
  start(kind: CliOperationKindOf<View>): CliOperationId
  /** @returns after the named operation settles, or at once when it is not cancellable. */
  cancel(id: CliOperationId): Promise<void>
}

/** One operation a page button may start, with the text its success reports in the browser that started it. */
export interface CliAccountOperation<Kind extends string> {
  readonly kind: Kind
  readonly notice?: LocalizedText
}

/** One CLI app plugin's account on the Plugins page, registered with the Host's `ctx.cliAccounts`. */
export interface CliAccountRegistration<View extends AnyCliAccountView> {
  /** npm package whose bundle page carries the section and tag. */
  readonly packageName: string
  readonly source: CliAccountSource<View>
  /** The operations a page button may start; the registry rejects any other. */
  readonly operations: readonly CliAccountOperation<CliOperationKindOf<View>>[]
  readonly copy: CliAccountCopy
  /** Map the current view to what the section shows; called on each change for each subscriber. */
  readonly present: (view: View) => CliAccountDisplay
}
