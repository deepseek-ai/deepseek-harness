/** Registration and dictionary types a connector plugin uses to show its MCP account on the Plugins page. */
import type { LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionFace } from './connection.ts'

/** Every key a connector's account dictionary translates. */
export type McpAccountKey =
  | 'section.title'
  | 'status.checking' | 'status.disconnected' | 'status.waiting-browser' | 'status.authorizing'
  | 'status.connecting' | 'status.connected' | 'status.reconnect' | 'status.unavailable'
  | 'detail.disconnected' | 'detail.waiting-browser' | 'detail.authorizing' | 'detail.connecting' | 'detail.connected'
  | 'detail.reconnect.expired' | 'detail.reconnect.binding' | 'detail.reconnect.rejected' | 'detail.reconnect.scope'
  | 'detail.unavailable'
  | 'hostBrowser' | 'failed'
  | 'action.connect' | 'action.reconnect' | 'action.open' | 'action.cancel' | 'action.signOut' | 'action.retry'
  | 'badge.connected' | 'badge.disconnected' | 'badge.reconnect' | 'badge.unavailable' | 'badge.connecting'
  | 'signOut.title' | 'signOut.body'
  | 'activation.title' | 'activation.body' | 'activation.later'
  | 'notice.connected' | 'notice.signed-out' | 'notice.action-failed'
  | 'close'

type LocaleNamespace = Extract<keyof LocaleNamespaceMap, string>

/** Locale namespaces whose dictionary is exactly {@link McpAccountKey}. */
export type McpAccountNamespace = {
  [N in LocaleNamespace]: [LocaleNamespaceMap[N]] extends [McpAccountKey]
    ? [McpAccountKey] extends [LocaleNamespaceMap[N]] ? N : never
    : never
}[LocaleNamespace]

/** One connector's managed server, the bundle page that shows it, and the dictionary that names it. */
export interface McpAccountRegistration {
  /** Name the connector registers its server under with the MCP manager. */
  readonly server: string
  /** npm package whose bundle page carries the account section. */
  readonly packageName: string
  /** The connector's dictionary namespace. */
  readonly locale: McpAccountNamespace
}

/** The account face each slot entry injects. */
export type McpAccountFace = ConnectionFace & { readonly packageName: string }

/** The `ctx.mcpAccounts` registry. */
export interface McpAccounts {
  /**
   * Show one account's section, title tag, activation guidance, and notices on the Plugins page.
   * @param account - the server, its bundle package, and its dictionary namespace.
   * @returns an idempotent disposer that removes the surfaces and stops observing the server.
   * @throws when another registration already occupies the package's bundle slots.
   */
  register(account: McpAccountRegistration): () => void
}
