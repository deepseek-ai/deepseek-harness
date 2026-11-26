/**
 * One managed MCP server as its own plugin row, beside the entries of the manager row's `servers` dictionary. The
 * row registers its server with the manager for the row's lifetime, so a composition layer adds, edits, switches
 * off, or removes one server without restating the others: a bundle patch, a profile patch, a `--patch` overlay.
 *
 * ```yaml
 * - id: mcp-server-docs
 *   name: '@deepseek-ai/dsh-mcp-manager/server'
 *   config:
 *     serverName: docs
 *     transport: streamable-http
 *     url: https://mcp.example.com/mcp
 * ```
 *
 * The row's `disabled` field switches the server off: the Loader unloads the row, and the manager unmounts the
 * server and withdraws its tools. An edited row restarts alone, and an invalid row fails alone. A row whose
 * `serverName` a `servers` entry or another registration already holds fails, and the earlier declaration keeps
 * serving. The row's schema refuses a config that sets `enabled`.
 *
 * Function plugin (named exports, no default export).
 *
 * @module @deepseek-ai/dsh-mcp-manager/server
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ServerEntrySchema } from './entry.ts'
import type { McpManagedServerEntry, McpServerRegistration } from './entry.ts'
// Side-effect type import: declares `ctx.mcpManager`.
import type {} from './index.ts'

export const name = 'mcp-manager-server'

export const inject = ['mcpManager']

/** One managed server and the name it registers under; the row's own `disabled` field replaces an entry's `enabled`. */
export interface Config extends Omit<McpManagedServerEntry, 'enabled'> {
  /** Server name and tool namespace, unique among the manager's servers. */
  serverName: string
}

/**
 * The fields of a row: `serverName` beside the fields of one `servers` entry. `enabled` accepts no value: a
 * registration is enabled while it exists, so an `enabled: false` copied from a `servers` entry would start the server.
 */
const rowFields: Record<string, z> = {
  serverName: z.string().required(),
  ...ServerEntrySchema.dict,
  enabled: z.never().description('Not accepted on a server row. Switch the server off with the row\'s "disabled" field.'),
}

/** Schema for {@link Config}. */
export const Config = z.object(rowFields) as z<McpServerRegistration & Pick<Config, 'serverName'>, Config>

/**
 * Register this row's server with the manager for the row's lifetime.
 * @param ctx - the row's plugin context; its disposal removes the server.
 * @param config - the row's resolved config.
 * @throws when the manager refuses the registration.
 */
export function apply(ctx: Context, config: Config): void {
  const { serverName, ...entry } = config
  ctx.mcpManager.register(serverName, entry)
}
