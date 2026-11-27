/** Browser-side state and face of the accounts the Plugins page shows. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ConnectorAccountEntry, ConnectorOperationId } from '../types.ts'

/** A transient outcome the page reports outside its own lifetime; `seq` distinguishes repeats. */
export type ConnectorAccountNotice =
  | { readonly seq: number; readonly kind: 'succeeded'; readonly text: LocalizedText }
  | { readonly seq: number; readonly kind: 'action-failed' }

/** What this browser shows: the Host's accounts, the stream state, and the latest notice. */
export interface ConnectorAccountsState {
  /** Registered accounts by key, as the Host last published them. */
  readonly accounts: ReadonlyMap<string, ConnectorAccountEntry>
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  readonly notice: ConnectorAccountNotice | undefined
}

/** The face every surface entry injects. */
export interface ConnectorAccountFace {
  hooks: { connectorAccounts: HostObservable<ConnectorAccountsState> }
  /**
   * Start an operation of an account on the Host. The Remote result carries the operation the Host started, or the
   * failure when the Host refuses or the call does not answer.
   */
  readonly start: ClientRemote['connectorAccounts']['start']
  /** Cancel an account's operation on the Host; the Remote result carries a failure like `start`. */
  readonly cancel: ClientRemote['connectorAccounts']['cancel']
  /** Pick the active language's entry of a registrant's text. */
  readonly resolveText: (text: LocalizedText) => string
  /** Remember an operation this browser started: its authorization page opens here, and its success is reported here. */
  readonly follow: (key: string, id: ConnectorOperationId) => void
  /** Report that a Remote call this browser made did not finish. */
  readonly failed: () => void
  readonly dismissNotice: () => void
}

/** The face of a bundle's own surfaces, which show the bundle's account. */
export interface ConnectorBundleAccountFace extends ConnectorAccountFace {
  /** The key of the account the bundle owns. */
  readonly account: string
}

/** What a surface outside the account's bundle page passes to the `connector.account` Factory. */
export interface ConnectorAccountFactoryInput {
  /** The key of the account to show, such as `mcp:<server>`. */
  readonly account: string
  /** `section` shows the account's whole section; `status` only its state dot and status line, as in a list row. */
  readonly presentation: 'section' | 'status'
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotFactoryMap {
    /** One registered account by key, for a surface outside the account's bundle page; nothing before the Host lists it. */
    'connector.account': { scope: 'root'; props: ConnectorAccountFactoryInput; locale: 'connectorAccount'; inject: ConnectorAccountFace }
  }
}
