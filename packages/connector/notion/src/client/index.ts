/**
 * Notion plugin, browser half: the connection section on the Notion bundle's
 * page, the tag beside its title, guidance after the bundle is switched on,
 * and connection notices. Authorization, status, and sign-out go through the
 * MCP manager's Remote; the page keeps no connection state of its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { NOTION_PACKAGE, NotionConnection } from './connection.ts'
import { en, NS, zh } from './locales.ts'
import { NotionConnectionActivation, NotionConnectionBadge, NotionConnectionSection, NotionConnectionToast } from './NotionConnection.tsx'

/** Services the slot registrations and the manager Remote need. */
export const inject = ['remote', 'remote.mcpServers', 'slots', 'locale']

/**
 * Register the Notion connection surfaces for as long as the Notion row is on.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'notion: dictionaries')
  const connection = new NotionConnection(ctx)
  ctx.effect(() => async () => { await connection.dispose() }, 'notion: connection')
  const face = connection.face()
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: NOTION_PACKAGE, locale: NS, inject: () => face,
  }, NotionConnectionSection))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation', key: NOTION_PACKAGE, locale: NS, inject: () => face,
  }, NotionConnectionActivation))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge', id: 'notion.connection', locale: NS, inject: () => face,
  }, NotionConnectionBadge))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'notion.connection-toast', locale: NS, inject: () => face,
  }, NotionConnectionToast))
}
