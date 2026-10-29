/** Registration, display, and dictionary types a CLI app plugin uses to show its account on the Plugins page. */
import type { CliAccountView, CliCommandFailure, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { HostObservable, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Any plugin's Host account view; each plugin supplies its own account, operation, and failure types. */
export type AnyCliAccountView = CliAccountView<unknown, string, string>

/** The operation kinds a plugin's view reports results for. */
export type CliOperationKindOf<View extends AnyCliAccountView> = NonNullable<View['result']>['kind']

/** What the page shows about a plugin's account; each plugin maps its own account states onto these phases. */
export type CliAccountPhase = 'checking' | 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'stopped'

/** Dictionary keys the shared surfaces read from every CLI plugin's namespace. */
export type CliAccountKey =
  | 'section.title' | 'hint' | 'close' | 'action.cancel' | 'action.connect'
  | 'activation.title' | 'activation.body' | 'activation.later'
  | 'failure.details' | 'failure.exitCode' | 'notice.action-failed'
  | `badge.${Exclude<CliAccountPhase, 'checking'>}`
  | `status.${Exclude<CliAccountPhase, 'connecting'>}`

type LocaleNamespace = Extract<keyof LocaleNamespaceMap, string>

/** Locale namespaces whose dictionary translates every {@link CliAccountKey}. */
export type CliAccountNamespace = {
  [N in LocaleNamespace]: [CliAccountKey] extends [LocaleNamespaceMap[N]] ? N : never
}[LocaleNamespace]

/** A transient outcome the page reports outside its own lifetime; `seq` distinguishes repeats. */
export type CliAccountNotice<Kind extends string> =
  | { readonly seq: number; readonly kind: 'succeeded'; readonly operation: Kind }
  | { readonly seq: number; readonly kind: 'action-failed' }

/** The page's whole view: the Host's account view plus this browser's stream state, pending action, and notice. */
export interface CliAccountSnapshot<View extends AnyCliAccountView> {
  /** The Host's view; undefined until the stream reports one. */
  readonly view: View | undefined
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  /** Whether the Host stream failed for good, as when the plugin's Host component is not running; `retry` reopens it. */
  readonly stopped: boolean
  /** Whether an action this page started has not answered. */
  readonly busy: boolean
  readonly notice: CliAccountNotice<CliOperationKindOf<View>> | undefined
}

/** The page actions a plugin's buttons call. */
export interface CliAccountPage {
  /**
   * Start an operation through the plugin's Remote; a click while another action is pending is ignored. The page then
   * follows the returned operation in place of any earlier one; a rejected start leaves it following none and reports
   * the `action-failed` notice.
   */
  readonly start: (call: () => Promise<RemoteResult<CliOperationId>>) => void
  /** Cancel the current operation when the Host marks it cancellable. */
  readonly cancel: () => void
  /** Open the current operation's authorization link again, over HTTPS only. */
  readonly openAuthorization: () => void
  /** Reopen the Host stream after it stopped; ignored while it runs or while a reopen is pending. */
  readonly retry: () => void
}

/** The question an action asks before it runs. */
export interface CliAccountConfirmation {
  readonly title: string
  readonly body: string
  /** The confirm button's label. */
  readonly label: string
}

/** One button in the section; the section disables it while an action is pending or the Host stream is down. */
export interface CliAccountAction {
  readonly label: string
  readonly onClick: () => void
  /** Defaults to an outline button. */
  readonly variant?: 'primary' | 'ghost'
  /** Ask first, for an action that changes the account outside DSH, such as signing out of a CLI the terminal shares. */
  readonly confirm?: CliAccountConfirmation
}

/** One extra row under the status line, such as the linked app, with an optional button. */
export interface CliAccountNote {
  readonly text: string
  readonly action?: CliAccountAction
}

/** A failed operation as the section reports it. */
export interface CliAccountFailure {
  /** The plugin's recovery guidance. */
  readonly text: string
  /** The Host's classified command, shown as a diagnostic after the guidance. */
  readonly command?: CliCommandFailure | undefined
  /** The plugin's allowlisted classification fields, appended in order; undefined entries are skipped. */
  readonly details?: readonly (string | undefined)[]
}

/** What the section shows; the plugin translates every string. */
export interface CliAccountDisplay {
  readonly phase: CliAccountPhase
  /** The status label; defaults to the `status.*` copy for the phase, with `connecting` labelled as checking. */
  readonly status?: string | undefined
  /** The first `primary` action that asks no confirmation also answers Connect in the activation prompt. */
  readonly actions?: readonly CliAccountAction[]
  readonly detail?: string | undefined
  readonly notes?: readonly CliAccountNote[]
  readonly failure?: CliAccountFailure | undefined
}

/** One CLI app plugin's account: its bundle page, dictionary, Remote operations, and presentation. */
export interface CliAccountRegistration<View extends AnyCliAccountView> {
  /** npm package whose bundle page carries the section and tag. */
  readonly packageName: string
  /** The plugin's dictionary namespace, which supplies the {@link CliAccountKey} copy. */
  readonly locale: CliAccountNamespace
  /** Open one generation of the plugin's `follow` stream. */
  readonly follow: (signal: AbortSignal) => AsyncIterable<View>
  /** Cancel one operation through the plugin's Remote. */
  readonly cancel: (id: CliOperationId) => Promise<RemoteResult<void>>
  /**
   * The translated notice each operation kind reports when an operation this browser started succeeds; unlisted kinds
   * report none.
   */
  readonly notices: Readonly<Partial<Record<CliOperationKindOf<View>, () => string>>>
  /**
   * Derive what the section shows. The surfaces call it while rendering, so it reads nothing else that changes outside
   * React; translating through `ctx.locale.bind` follows the active language.
   */
  readonly present: (snapshot: CliAccountSnapshot<View>, page: CliAccountPage) => CliAccountDisplay
}

/** The `ctx.cliAccounts` registry. */
export interface CliAccounts {
  /**
   * Show one account's section, title tag, activation prompt, and notices on the Plugins page.
   * @param account - the bundle package, dictionary namespace, Remote operations, and presentation.
   * @returns an idempotent disposer that removes the surfaces and closes the Host stream.
   * @throws when another registration already occupies the package's bundle slots.
   */
  register<View extends AnyCliAccountView>(account: CliAccountRegistration<View>): () => void
}

/** The face every surface entry of one registration injects. */
export interface CliAccountFace {
  hooks: { cliAccount: HostObservable<CliAccountSnapshot<AnyCliAccountView>> }
  readonly packageName: string
  readonly page: CliAccountPage
  readonly notices: Readonly<Partial<Record<string, () => string>>>
  readonly dismissNotice: () => void
  /**
   * The registration's `present`. Method syntax lets the presenter typed by the plugin's own view stand in for one typed
   * by any view.
   * @param snapshot - the page snapshot the surface rendered from.
   * @param page - the page actions.
   * @returns the section's display.
   */
  present(snapshot: CliAccountSnapshot<AnyCliAccountView>, page: CliAccountPage): CliAccountDisplay
}
