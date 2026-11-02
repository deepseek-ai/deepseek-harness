/** Browser-side state and face of the connector accounts the Plugins page shows. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { McpAccountEntry } from '../types.ts'

/** A transient outcome the page reports outside its own lifetime; `seq` distinguishes repeats. */
export interface McpAccountNotice {
  readonly seq: number
  readonly kind: 'connected' | 'signed-out' | 'action-failed'
}

/** One account as this browser shows it: the Host's entry plus the stream state, pending action, and notice. */
export interface McpAccountSnapshot {
  readonly entry: McpAccountEntry
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  /** Whether an action this browser started for the account has not settled. */
  readonly busy: boolean
  readonly notice: McpAccountNotice | undefined
}

/** The face every surface entry of one account injects. */
export interface McpAccountFace {
  hooks: { mcpAccount: HostObservable<McpAccountSnapshot> }
  readonly packageName: string
  /** Pick the active language's entry of the connector's text. */
  readonly resolveText: (text: LocalizedText) => string
  readonly connect: () => void
  readonly cancel: () => void
  readonly signOut: () => void
  readonly retry: () => void
  readonly openAuthorization: () => void
  readonly dismissNotice: () => void
}
