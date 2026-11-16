/**
 * Credential-free account views of connector plugins, and what the Plugins page receives about them. Each registrant
 * supplies its own account, operation, phase, and failure types and maps its views to the page's display, so CLI app
 * plugins and MCP connectors share one registry and one page.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** Identifies one Host-owned account operation across the browsers that show the account. */
export type ConnectorOperationId = Branded<'ConnectorOperationId'>

/** The account operation in progress; `Phase` names the registrant's own steps. */
export interface ConnectorOperation<Kind extends string, Phase extends string> {
  readonly id: ConnectorOperationId
  readonly kind: Kind
  readonly phase: Phase
  /** Whether the source cancels the operation in its current phase. */
  readonly cancellable: boolean
  /** The page the user authorizes in, while the operation waits for one; only the browser that started it opens it. */
  readonly authorizationUrl?: string
}

/** The most recent finished operation, kept until another one starts. */
export interface ConnectorOperationResult<Kind extends string, Failure = unknown> {
  readonly id: ConnectorOperationId
  readonly kind: Kind
  readonly outcome: 'succeeded' | 'cancelled' | 'failed'
  /** The registrant's classified failure, for its own presentation; does not imply rollback or a safe retry. */
  readonly failure?: Failure
}

/** The complete account view; observers reread it after each change. */
export interface ConnectorAccountView<Account, Kind extends string, Phase extends string, Failure = unknown> {
  /** The account as the source last published it. */
  readonly account: Account
  readonly operation?: ConnectorOperation<Kind, Phase>
  readonly result?: ConnectorOperationResult<Kind, Failure>
}

/** Any registrant's account view. */
export type AnyConnectorAccountView = ConnectorAccountView<unknown, string, string>

/** The operation kinds a view reports. */
export type ConnectorOperationKindOf<View extends AnyConnectorAccountView> = NonNullable<View['result']>['kind']

/** What the Plugins page shows about an account; each registrant maps its own account states onto these phases. */
export type ConnectorAccountPhase = 'checking' | 'connecting' | 'connected' | 'disconnected' | 'unavailable'

/** What a section button does. */
export type ConnectorAccountCommand =
  /** Start one of the operations the account registered as page actions. */
  | { readonly kind: 'start'; readonly operation: string }
  /** Cancel the operation in progress when it is cancellable. */
  | { readonly kind: 'cancel' }
  /** Open the current operation's authorization page again in this browser. */
  | { readonly kind: 'open' }

/** The question a button asks before it runs. */
export interface ConnectorAccountConfirmation {
  readonly title: LocalizedText
  readonly body: LocalizedText
  /** The confirm button's label. */
  readonly label: LocalizedText
}

/** One button in the section. */
export interface ConnectorAccountButton {
  readonly label: LocalizedText
  readonly command: ConnectorAccountCommand
  /** Defaults to an outline button. */
  readonly variant?: 'primary' | 'ghost'
  /** Ask first, for an action that changes the account outside DSH, such as signing out. */
  readonly confirm?: ConnectorAccountConfirmation
}

/** One extra row under the status line, such as the linked app, with an optional button. */
export interface ConnectorAccountNote {
  readonly text: LocalizedText
  readonly button?: ConnectorAccountButton
}

/** A failed operation as the section reports it. */
export interface ConnectorAccountFailure {
  /** The registrant's recovery guidance. */
  readonly text: LocalizedText
  /** Untranslated diagnostic items shown after the guidance in order. */
  readonly details?: readonly string[]
}

/** What the section shows for the current view; every text carries each shipped language. */
export interface ConnectorAccountDisplay {
  readonly phase: ConnectorAccountPhase
  readonly status: LocalizedText
  /** The tag beside the bundle title; absent while nothing is settled. */
  readonly badge?: LocalizedText
  readonly buttons: readonly ConnectorAccountButton[]
  /** What Connect in the activation prompt starts after opening the bundle page; absent, Connect only opens the page. */
  readonly connect?: Extract<ConnectorAccountCommand, { readonly kind: 'start' }>
  readonly detail?: LocalizedText
  readonly notes: readonly ConnectorAccountNote[]
  readonly failure?: ConnectorAccountFailure
}

/** The section's fixed text that names the service or uses its wording. */
export interface ConnectorAccountCopy {
  readonly title: LocalizedText
  /** The line under the section, such as where the account is shared or authorized. */
  readonly hint: LocalizedText
  /** The prompt after the bundle is switched on while the account is disconnected. */
  readonly activation: { readonly title: LocalizedText; readonly body: LocalizedText; readonly connect: LocalizedText }
}

/** One registered account as the Plugins page receives it. */
export interface ConnectorAccountEntry {
  /** The registrant's stable account key, which the page passes back to start and cancel operations. */
  readonly key: string
  /** npm package whose bundle page carries the section and tag; absent for an account no bundle owns. */
  readonly packageName?: string
  readonly copy: ConnectorAccountCopy
  readonly display: ConnectorAccountDisplay
  /** The operation in progress, which a browser follows when it started it. */
  readonly operation?: { readonly id: ConnectorOperationId; readonly authorizationUrl?: string }
  /** The most recent finished operation, with the registrant's text when it succeeded. */
  readonly result?: { readonly id: ConnectorOperationId; readonly notice?: LocalizedText }
}

/** Every registered account, as each change publishes it. */
export interface ConnectorAccountsView {
  readonly accounts: readonly ConnectorAccountEntry[]
}

/** The account a registration exposes to the page. */
export interface ConnectorAccountSource<View extends AnyConnectorAccountView> {
  snapshot(): View
  /** @returns a disposer; the listener runs after each change without starting a check. */
  observe(listener: () => void): () => void
  /** Start a check unless an operation runs; a source whose view is always current does nothing. */
  refresh(): void
  /** @returns the started operation's identity, at once or after the source has started the operation. */
  start(kind: ConnectorOperationKindOf<View>): ConnectorOperationId | Promise<ConnectorOperationId>
  /** @returns after the named operation settles, or at once when it is not cancellable. */
  cancel(id: ConnectorOperationId): Promise<void>
}

/** One operation a page button may start, with the text its success reports in the browser that started it. */
export interface ConnectorAccountOperation<Kind extends string> {
  readonly kind: Kind
  readonly notice?: LocalizedText
}

/** One connector account, registered with the Host's `ctx.connectorAccounts`. */
export interface ConnectorAccountRegistration<View extends AnyConnectorAccountView> {
  /** Stable key, unique among registered accounts, such as the bundle's package name. */
  readonly key: string
  /** npm package whose bundle page carries the section and tag; at most one account per package. */
  readonly packageName?: string
  readonly source: ConnectorAccountSource<View>
  /** The operations a page button may start; the registry rejects any other. */
  readonly operations: readonly ConnectorAccountOperation<ConnectorOperationKindOf<View>>[]
  readonly copy: ConnectorAccountCopy
  /** Map the current view to what the section shows; called on each change for each subscriber. */
  readonly present: (view: View) => ConnectorAccountDisplay
}
