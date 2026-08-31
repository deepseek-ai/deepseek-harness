/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mcp-manager`.
 * @module @deepseek-ai/dsh-mcp-manager/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Side-effect type import: declaration-merges the manager event and `ctx.mcpServers`.
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-manager'

/** Cordis companion plugin name. */
export const name = 'mcp-manager-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the status-event containment contract: `mcp-manager/status` names a
 * server the emitting manager currently lists — the event is documented as
 * firing only while the entry exists, so an emission for an unlisted name (or
 * with no live manager at all) means a lifecycle callback outlived its record.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('mcp-manager/status', (serverName) => {
    const manager = ctx.get('mcpServers')
    if (manager === undefined) {
      fail(`mcp-manager/status for "${serverName}" emitted without a live manager service`)
      return
    }
    if (!manager.list().some(view => view.name === serverName)) {
      fail(`mcp-manager/status for "${serverName}" emitted for a server the manager does not list`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
