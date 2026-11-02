/**
 * MCP account surfaces, browser half: follows the accounts connector plugins register on the Host and shows each one's
 * section, title tag, activation guidance, and notices on its bundle's Plugins page. The surfaces read the shared copy
 * from this package's dictionary and each connector's text from the Host.
 */
import type { Context } from '@deepseek-ai/cordis'
import mcpAccountsRemote from '@deepseek-ai/dsh-client-ui-mcp-account/remote'
import { mountMcpAccounts } from './mount.ts'

export { inject } from './mount.ts'
export type { McpAccountKey } from './locales.ts'
export type { McpAccountFace, McpAccountNotice, McpAccountSnapshot } from './types.ts'

/**
 * Show the registered connector accounts on the Plugins page.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the surfaces and the stream, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountMcpAccounts(ctx, mcpAccountsRemote)
}
