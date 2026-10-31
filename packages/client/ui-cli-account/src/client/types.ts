/** Browser-side state and face of the accounts the Plugins page shows. */
import type { CliAccountCommand, CliAccountEntry } from '@deepseek-ai/dsh-cli-account/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** A transient outcome the page reports outside its own lifetime; `seq` distinguishes repeats. */
export type CliAccountNotice =
  | { readonly seq: number; readonly kind: 'succeeded'; readonly text: LocalizedText }
  | { readonly seq: number; readonly kind: 'action-failed' }

/** One account as this browser shows it: the Host's entry plus the stream state, pending action, and notice. */
export interface CliAccountSnapshot {
  readonly entry: CliAccountEntry
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  /** Whether the Host stream failed for good; `retry` reopens it. */
  readonly stopped: boolean
  /** Whether an action this browser started for the account has not answered. */
  readonly busy: boolean
  readonly notice: CliAccountNotice | undefined
}

/** The face every surface entry of one account injects. */
export interface CliAccountFace {
  hooks: { cliAccount: HostObservable<CliAccountSnapshot> }
  readonly packageName: string
  /** Pick the active language's entry of the plugin's text. */
  readonly resolveText: (text: LocalizedText) => string
  /** Carry out a section button's command. */
  readonly run: (command: CliAccountCommand) => void
  /** Reopen the Host stream after it stopped. */
  readonly retry: () => void
  readonly dismissNotice: () => void
}
