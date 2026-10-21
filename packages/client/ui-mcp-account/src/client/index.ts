/**
 * MCP account surfaces for connector plugins, browser half. `ctx.mcpAccounts`
 * shows a plugin-registered OAuth server's account section, title tag,
 * activation guidance, and notices on its bundle's Plugins page.
 * Authorization, status, and sign-out go through the MCP manager's Remote;
 * the page keeps no connection state of its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { McpAccountConnection } from './connection.ts'
import { McpAccountActivation, McpAccountBadge, McpAccountSection, McpAccountToast } from './McpAccount.tsx'
import type { McpAccountFace, McpAccountRegistration, McpAccounts } from './types.ts'

export type { McpAccountKey, McpAccountNamespace, McpAccountRegistration, McpAccounts } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connector account surfaces on the Plugins page. */
    mcpAccounts: McpAccounts
  }
}

/** Services the slot registrations and the manager Remote need. */
export const inject = ['remote', 'remote.mcpServers', 'slots']

function register(ctx: Context, account: McpAccountRegistration): () => void {
  const { server, packageName, locale } = account
  const dispose = ctx.effect(function* () {
    const connection = new McpAccountConnection(ctx, server)
    yield async () => { await connection.dispose() }
    const face: McpAccountFace = { ...connection.face(), packageName }
    yield ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: packageName, locale, inject: () => face,
    }, McpAccountSection))
    yield ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
      name: 'plugins.bundle.activation', key: packageName, locale, inject: () => face,
    }, McpAccountActivation))
    yield ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
      name: 'plugins.detail.badge', id: `${server}.connection`, locale, inject: () => face,
    }, McpAccountBadge))
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: `${server}.connection-toast`, locale, inject: () => face,
    }, McpAccountToast))
  }, `mcpAccounts.register(${server})`)
  return () => void dispose()
}

/**
 * Provide the account registry; each registration lives until its disposer runs or this plugin unloads.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const accounts: McpAccounts = { register: account => register(ctx, account) }
  ctx.provide('mcpAccounts', accounts)
}
