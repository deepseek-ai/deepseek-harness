/**
 * Notion plugin, browser half: the Notion dictionary and the account
 * registration that shows the connection section, the tag beside the bundle
 * title, guidance after the bundle is switched on, and connection notices on
 * the Notion bundle's page.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-mcp-account/client'
import { en, NS, zh } from './locales.ts'

/** Services the dictionary and the account registration need. */
export const inject = ['locale', 'mcpAccounts']

/**
 * Register the Notion account surfaces for as long as the Notion row is on.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'notion: dictionaries')
  ctx.effect(() => ctx.mcpAccounts.register({
    server: 'notion', packageName: '@deepseek-ai/dsh-notion', locale: NS,
  }), 'notion: account')
}
