/** The Plugins page account a connector registers for its MCP server. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/**
 * The text that names the connector's service; every other string comes from this package's shared copy.
 * @typeParam Text - each string's type; a connector narrows it to require every language it ships.
 */
export interface McpAccountCopy<Text extends LocalizedText = LocalizedText> {
  /** The section title, such as the service's account. */
  readonly title: Text
  /** The connect button's label, which the activation prompt also uses. */
  readonly connect: Text
  /** The prompt after the bundle is switched on while no account is connected. */
  readonly activation: { readonly title: Text; readonly body: Text }
  /** The detail line of each state that names the service. */
  readonly detail: {
    readonly disconnected: Text
    readonly waitingBrowser: Text
    readonly authorizing: Text
    readonly connecting: Text
    readonly connected: Text
    /** The service no longer accepts the grant. */
    readonly rejected: Text
    /** The grant lacks a permission the server requires. */
    readonly scope: Text
  }
  /** The sign-out confirmation, including what signing out removes. */
  readonly signOut: { readonly title: Text; readonly body: Text }
  /** What a connection and a sign-out report in the browser that started them. */
  readonly notice: { readonly connected: Text; readonly signedOut: Text }
}

/** One connector's account, registered with the Host's `ctx.mcpAccounts`. */
export interface McpAccountRegistration {
  /** The name the connector registers its server under with the MCP manager; it also keys the account. */
  readonly server: string
  /** npm package whose bundle page carries the section and tag. */
  readonly packageName: string
  readonly copy: McpAccountCopy
}
