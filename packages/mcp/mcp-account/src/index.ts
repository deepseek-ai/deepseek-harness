/**
 * MCP connector accounts on the Plugins page. A connector plugin registers its OAuth server with `ctx.mcpAccounts`, and
 * this service shows the server's account through `ctx.connectorAccounts`: the MCP manager's status and authorization
 * decide what the section shows, and the page's operations authorize, cancel, sign out, and restart through the manager
 * on the Host.
 * @module @deepseek-ai/dsh-mcp-account
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import { present, sectionCopy, ServerAccount } from './account.ts'
import type { McpAccountRegistration } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** MCP connector accounts on the Plugins page. */
    mcpAccounts: McpAccounts
  }
}

/** Shows each connector's MCP server account in the connector account registry. */
export default class McpAccounts extends Service {
  static inject = ['mcpManager', 'connectorAccounts']

  /** A service method's `this.ctx` is the caller's context, so the accounts reach the manager and the registry through this one. */
  private readonly ownerContext: Context

  /** @param ctx - the Host context carrying the MCP manager and the connector account registry. */
  constructor(ctx: Context) {
    super(ctx, 'mcpAccounts')
    this.ownerContext = ctx
  }

  /**
   * Show one connector's server account on its bundle page for as long as the returned disposer has not run. The
   * account's key is `mcp:<server>`.
   * @param registration - the server name, the bundle package, and the connector's text.
   * @returns the registry's idempotent disposer, which withdraws the account.
   * @throws when another account already uses the server or the package.
   */
  register(registration: McpAccountRegistration): () => void {
    const { server, packageName, copy } = registration
    return this.ownerContext.connectorAccounts.register({
      key: `mcp:${server}`, packageName, source: new ServerAccount(this.ownerContext, server), copy: sectionCopy(copy),
      operations: [{ kind: 'connect', notice: copy.notice.connected }, { kind: 'sign-out', notice: copy.notice.signedOut }, { kind: 'retry' }],
      present: view => present(view, copy),
    })
  }
}
